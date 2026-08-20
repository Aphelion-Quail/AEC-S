import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type { JobInput, JobResult, JobState } from "./types.js";
import { newId, nowIso } from "./ids.js";
import { readJson, writeJsonAtomic } from "./files.js";
import { jobInputSchema, jobResultSchema } from "./input.js";
import { fingerprint } from "./fingerprint.js";
import { childEnvironment } from "./child-env.js";
import {
  descendantProcessIds,
  killProcessTreeByPid,
  killRecordedProcesses,
  processIdentity,
  processMatchesIdentity,
} from "./process-control.js";
import { isolatedCommand, isolationEnvironment } from "./isolation.js";

function within(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep));
}

function assertJobControlPaths(input: JobInput, inputPath: string): void {
  const controller = input.isolation.controllerPath;
  for (const [label, path] of [
    ["input", inputPath],
    ["result", input.resultPath],
    ["stdout", input.stdoutPath],
    ["stderr", input.stderrPath],
  ] as const) {
    if (!within(controller, path)) throw new Error(`Supervised Job ${label} path escapes controller ownership: ${path}`);
  }
  if (within(input.isolation.workspacePath, controller)) {
    throw new Error("Supervised Job controller path must not be writable through the Runtime workspace");
  }
  if (input.ephemeralEnvironmentPath && !within(controller, input.ephemeralEnvironmentPath)) {
    throw new Error(`Supervised Job ephemeral environment escapes controller ownership: ${input.ephemeralEnvironmentPath}`);
  }
}

type LockedProcess = { pid: number; startedAt?: string };
type SupervisorLockRecord = {
  version: 1;
  supervisor: LockedProcess;
  command?: Required<LockedProcess>;
  descendants?: Required<LockedProcess>[];
};

function readSupervisorLock(path: string): SupervisorLockRecord {
  const text = readFileSync(path, "utf8").trim();
  if (/^\d+$/.test(text)) return { version: 1, supervisor: { pid: Number(text) } };
  const value = JSON.parse(text) as Partial<SupervisorLockRecord>;
  if (value.version !== 1 || !Number.isInteger(value.supervisor?.pid) || value.supervisor!.pid <= 0) {
    throw new Error(`Supervised Job lock is malformed: ${path}`);
  }
  return value as SupervisorLockRecord;
}

function lockedProcessAlive(process: LockedProcess): boolean {
  return process.startedAt ? processMatchesIdentity(process.pid, process.startedAt) : processAlive(process.pid);
}

async function terminateStaleLockProcesses(record: SupervisorLockRecord): Promise<void> {
  const recorded = new Map((record.descendants ?? []).map((process) => [process.pid, process.startedAt]));
  if (record.command && processMatchesIdentity(record.command.pid, record.command.startedAt)) {
    killProcessTreeByPid(record.command.pid, "SIGKILL", () => {
      try { process.kill(record.command!.pid, "SIGKILL"); return true; } catch { return false; }
    });
  }
  killRecordedProcesses(recorded, "SIGKILL");
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    const commandAlive = record.command ? processMatchesIdentity(record.command.pid, record.command.startedAt) : false;
    const descendantAlive = [...recorded].some(([pid, startedAt]) => processMatchesIdentity(pid, startedAt));
    if (!commandAlive && !descendantAlive) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (commandAlive && record.command) {
      killProcessTreeByPid(record.command.pid, "SIGKILL", () => {
        try { process.kill(record.command!.pid, "SIGKILL"); return true; } catch { return false; }
      });
    }
    killRecordedProcesses(recorded, "SIGKILL");
  }
  throw new Error("AEC-S cannot safely recover a Job while its prior command process tree remains alive");
}

function preflightStaleSupervisor(resultPath: string): void {
  const lockPath = `${resultPath}.supervisor.lock`;
  if (!existsSync(lockPath)) return;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let record: SupervisorLockRecord;
    try { record = readSupervisorLock(lockPath); } catch { return; }
    if (!lockedProcessAlive(record.supervisor)) {
      if (record.command && processMatchesIdentity(record.command.pid, record.command.startedAt)) {
        killProcessTreeByPid(record.command.pid, "SIGKILL", () => {
          try { process.kill(record.command!.pid, "SIGKILL"); return true; } catch { return false; }
        });
      }
      killRecordedProcesses(new Map((record.descendants ?? []).map((process) => [process.pid, process.startedAt])), "SIGKILL");
      return;
    }
    // A just-signalled supervisor may still be visible for a few scheduler
    // ticks. Bound this preflight so normal concurrent reconcilers remain cheap.
    Atomics.wait(pause, 0, 0, 5);
  }
}

export async function runJobFile(inputPath: string, expectedDigest: string): Promise<void> {
  const input = jobInputSchema.parse(readJson<unknown>(inputPath)) as JobInput;
  assertJobControlPaths(input, inputPath);
  const inputDigest = fingerprint(input);
  if (expectedDigest.length !== 64 || inputDigest !== expectedDigest) {
    throw new Error(`Supervised JobInput integrity check failed: ${inputPath}`);
  }
  const supervisorLock = `${input.resultPath}.supervisor.lock`;
  const startGatePath = `${input.resultPath}.start`;
  let ownsSupervisorLock = false;
  let lockRecord: SupervisorLockRecord | undefined;
  const lockDeadline = Date.now() + (input.command.timeoutSeconds ?? 300) * 1_000 + 10_000;
  while (!ownsSupervisorLock) {
    if (existsSync(input.resultPath)) return;
    try {
      const lock = openSync(supervisorLock, "wx", 0o600);
      try {
        const startedAt = processIdentity(process.pid);
        if (!startedAt) throw new Error("AEC-S cannot establish the supervisor process identity");
        lockRecord = { version: 1, supervisor: { pid: process.pid, startedAt } };
        writeFileSync(lock, `${JSON.stringify(lockRecord)}\n`);
        fsyncSync(lock);
      } finally { closeSync(lock); }
      ownsSupervisorLock = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      let existing: SupervisorLockRecord;
      try { existing = readSupervisorLock(supervisorLock); }
      catch { continue; }
      if (!lockedProcessAlive(existing.supervisor)) {
        await terminateStaleLockProcesses(existing);
        try { unlinkSync(supervisorLock); } catch { /* Another reconciler won. */ }
        continue;
      }
      if (Date.now() >= lockDeadline) throw new Error(`Timed out waiting for existing supervisor ${existing.supervisor.pid}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  mkdirSync(dirname(input.stdoutPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(input.stderrPath), { recursive: true, mode: 0o700 });
  try { unlinkSync(startGatePath); } catch { /* A prior supervisor may not have reached its execution gate. */ }
  const startedAt = nowIso();
  const stdout = openSync(input.stdoutPath, "a", 0o600);
  const stderr = openSync(input.stderrPath, "a", 0o600);
  let finished = false;
  let outputLimitExceeded: string | undefined;
  let sandboxDenied = false;
  let stdinError: string | undefined;
  const outputLimit = 8 * 1024 * 1024;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const finish = (result: Omit<JobResult, "inputDigest">): void => {
    if (finished) return;
    finished = true;
    closeSync(stdout);
    closeSync(stderr);
    writeJsonAtomic(input.resultPath, { ...result, inputDigest });
    try { unlinkSync(startGatePath); } catch { /* The result is already durable. */ }
    if (ownsSupervisorLock) {
      try { unlinkSync(supervisorLock); } catch { /* Result is already durable. */ }
    }
  };
  try {
    const environmentProfile = input.environmentProfile ?? "restricted";
    const launch = isolatedCommand(input.command, input.isolation, environmentProfile, startGatePath);
    const isolationOverrides = isolationEnvironment(input.isolation, environmentProfile);
    const ephemeralEnvironment = input.ephemeralEnvironmentPath && existsSync(input.ephemeralEnvironmentPath)
      ? readJson<Record<string, string>>(input.ephemeralEnvironmentPath)
      : {};
    if (input.ephemeralEnvironmentPath) {
      try { unlinkSync(input.ephemeralEnvironmentPath); } catch { /* Capability expiry also closes the gateway. */ }
    }
    const child = spawn(launch.program, launch.args, {
      cwd: launch.cwd,
      env: childEnvironment(environmentProfile, { ...input.command.env, ...isolationOverrides, ...ephemeralEnvironment }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const observedDescendants = new Map<number, string>();
    const detachedRoots = new Map<number, string>();
    let timedOut = false;
    let descendantTrackingError: string | undefined;
    let terminateTree: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const forwardCancellation = (): void => {
      // Signal the controlled Runtime entrypoint first so protocol-aware
      // adapters can issue session/cancel or close their composition cleanly.
      // A bounded process-group kill remains the deterministic backstop.
      child.kill("SIGTERM");
      if (!terminateTree) {
        terminateTree = setTimeout(() => killProcessTreeByPid(child.pid, "SIGTERM", () => child.kill("SIGTERM")), 250);
        terminateTree.unref();
      }
      if (!forceKill) {
        forceKill = setTimeout(() => killProcessTreeByPid(child.pid, "SIGKILL", () => child.kill("SIGKILL")), 2_000);
        forceKill.unref();
      }
    };
    if (!child.pid) throw new Error("AEC-S could not obtain the supervised command PID");
    let childStartedAt: string | undefined;
    try {
      childStartedAt = processIdentity(child.pid);
      if (!childStartedAt) throw new Error("AEC-S could not establish the supervised command identity");
    } catch (error) {
      // The command gate has not been opened yet, but it is still a live child.
      // Never leave it behind if native process identity cannot be established.
      killProcessTreeByPid(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
      throw error;
    }
    lockRecord = { ...lockRecord!, command: { pid: child.pid, startedAt: childStartedAt } };
    writeJsonAtomic(supervisorLock, lockRecord);
    writeJsonAtomic(startGatePath, { inputDigest, command: lockRecord.command });
    const recordDescendants = (): void => {
      if (descendantTrackingError) return;
      try {
        let changed = false;
        const covered = descendantProcessIds(child.pid);
        const observe = (processes: ReadonlyMap<number, string>): void => {
          for (const [pid, startedAt] of processes) {
            covered.set(pid, startedAt);
            if (observedDescendants.get(pid) === startedAt) continue;
            observedDescendants.set(pid, startedAt);
            changed = true;
          }
        };
        observe(covered);

        // Once an observed process has been reparented out of the command
        // tree, keep only the top of that live subtree as a tracking root.
        // The roots remain disjoint, so each active process is recursively
        // enumerated at most once per census instead of once per ancestor.
        for (const [pid, startedAt] of detachedRoots) {
          if (covered.get(pid) === startedAt) {
            detachedRoots.delete(pid);
            continue;
          }
          const currentStartedAt = processIdentity(pid);
          if (currentStartedAt !== startedAt) {
            // A zombie can retain children for the brief interval before they
            // are reparented. Preserve the old last-chance census for a gone
            // identity, but never walk a PID already reused by another process.
            if (currentStartedAt === undefined) observe(descendantProcessIds(pid));
            detachedRoots.delete(pid);
            if (observedDescendants.get(pid) === startedAt) {
              observedDescendants.delete(pid);
              changed = true;
            }
            continue;
          }
          covered.set(pid, startedAt);
          observe(descendantProcessIds(pid));
        }

        // Anything previously observed but no longer covered is either dead
        // or the root of a newly detached subtree. Identity checks prevent PID
        // reuse from expanding supervision into an unrelated process tree.
        for (const [pid, startedAt] of observedDescendants) {
          if (covered.get(pid) === startedAt) continue;
          const currentStartedAt = processIdentity(pid);
          if (currentStartedAt !== startedAt) {
            if (currentStartedAt === undefined) observe(descendantProcessIds(pid));
            observedDescendants.delete(pid);
            detachedRoots.delete(pid);
            changed = true;
            continue;
          }
          const descendants = descendantProcessIds(pid);
          // If discovery order temporarily selected a nested process first,
          // collapse it under the newly identified ancestor on this tick.
          for (const [descendantPid, descendantStartedAt] of descendants) {
            if (detachedRoots.get(descendantPid) === descendantStartedAt) detachedRoots.delete(descendantPid);
          }
          detachedRoots.set(pid, startedAt);
          covered.set(pid, startedAt);
          observe(descendants);
        }
        if (changed) {
          lockRecord = {
            ...lockRecord!,
            descendants: [...observedDescendants].map(([pid, startedAt]) => ({ pid, startedAt })),
          };
          writeJsonAtomic(supervisorLock, lockRecord);
        }
      } catch (error) {
        descendantTrackingError = error instanceof Error ? error.message : String(error);
        forwardCancellation();
      }
    };
    recordDescendants();
    // libproc is fast enough to observe the brief spawn -> setsid -> reparent
    // window that a ps-based 50 ms census misses.
    const descendantCensus = setInterval(recordDescendants, process.platform === "darwin" ? 1 : 25);
    descendantCensus.unref();
    const writeBounded = (descriptor: number, chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const previous = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, outputLimit - previous);
      if (remaining > 0) writeSync(descriptor, chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes = previous + chunk.length;
      else stderrBytes = previous + chunk.length;
      if (chunk.length > remaining && !outputLimitExceeded) {
        outputLimitExceeded = `${stream} exceeded 8 MiB`;
        forwardCancellation();
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => writeBounded(stdout, chunk, "stdout"));
    child.stderr!.on("data", (chunk: Buffer) => {
      if (/\bEPERM\b|operation not permitted/i.test(chunk.toString("utf8"))) sandboxDenied = true;
      writeBounded(stderr, chunk, "stderr");
    });
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
      // A short-lived command may exit before the parent closes an otherwise
      // empty stdin pipe. That EPIPE does not invalidate the observed command
      // result. Failure to deliver actual Runtime input is operational.
      if ((input.stdin?.length ?? 0) > 0 || error.code !== "EPIPE") stdinError = error.message;
    });
    const onSignal = (): void => forwardCancellation();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    const timeout = setTimeout(() => {
      timedOut = true;
      forwardCancellation();
    }, (input.command.timeoutSeconds ?? 300) * 1_000);
    timeout.unref();
    child.on("error", (error) => {
      clearInterval(descendantCensus);
      clearTimeout(timeout);
      if (terminateTree) clearTimeout(terminateTree);
      if (forceKill) clearTimeout(forceKill);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      finish({
        status: "spawn_error",
        exitCode: null,
        signal: null,
        error: error.message,
        startedAt,
        finishedAt: nowIso(),
      });
    });
    child.on("close", async (exitCode, signal) => {
      recordDescendants();
      clearInterval(descendantCensus);
      clearTimeout(timeout);
      if (terminateTree) clearTimeout(terminateTree);
      if (forceKill) clearTimeout(forceKill);
      // The Runtime entrypoint may exit immediately after its graceful signal
      // while descendants remain in the detached process group. Clearing the
      // timers without this final sweep would let those descendants outlive a
      // completed cancellation result and continue mutating the workspace.
      // A Runtime is not allowed to leave detached helpers behind after its
      // entrypoint has completed, even on the nominal success path.
      killProcessTreeByPid(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
      killRecordedProcesses(observedDescendants, "SIGKILL");
      const convergenceDeadline = Date.now() + 1_000;
      while (Date.now() < convergenceDeadline && [...observedDescendants].some(([pid, startedAt]) => processMatchesIdentity(pid, startedAt))) {
        killRecordedProcesses(observedDescendants, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const escapedDescendants = [...observedDescendants].filter(([pid, startedAt]) => processMatchesIdentity(pid, startedAt));
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      finish({
        status: descendantTrackingError || escapedDescendants.length > 0 || stdinError ? "spawn_error" : outputLimitExceeded ? "output_limit" : timedOut ? "timed_out" : sandboxDenied && exitCode !== 0 ? "sandbox_denied" : "completed",
        exitCode,
        signal,
        ...(descendantTrackingError
          ? { error: `Failed to track supervised descendants: ${descendantTrackingError}` }
          : escapedDescendants.length > 0
            ? { error: `Supervised command left ${escapedDescendants.length} descendant process(es) alive` }
            : stdinError
              ? { error: `Failed to deliver supervised Job input: ${stdinError}` }
              : outputLimitExceeded ? { error: outputLimitExceeded } : {}),
        startedAt,
        finishedAt: nowIso(),
      });
    });
    child.stdin!.end(input.stdin ?? "");
  } catch (error) {
    finish({
      status: "spawn_error",
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: nowIso(),
    });
  }
}

const processStateCache = new Map<number, { checkedAt: number; alive: boolean }>();

export type ProcessInspector = (pid: number) => {
  status: number | null;
  stdout?: string | Buffer | null;
  error?: Error;
};

function inspectProcess(pid: number): ReturnType<ProcessInspector> {
  return spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
  });
}

export function processAlive(pid: number, inspector: ProcessInspector = inspectProcess): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    processStateCache.delete(pid);
    return false;
  }
  const useCache = inspector === inspectProcess;
  const cached = useCache ? processStateCache.get(pid) : undefined;
  if (cached && Date.now() - cached.checkedAt < 1_000) return cached.alive;
  let alive = true;
  if (process.platform !== "win32") {
    const status = inspector(pid);
    const stdout = typeof status.stdout === "string"
      ? status.stdout
      : Buffer.isBuffer(status.stdout) ? status.stdout.toString("utf8") : "";
    const state = stdout.trim();
    // process.kill(pid, 0) already proved the PID exists. The secondary ps
    // inspection only refines that answer for zombies; if ps is unavailable or
    // times out under load, conservatively keep the process alive.
    alive = status.error || status.status !== 0 || state.length === 0
      ? true
      : !state.startsWith("Z");
  }
  if (useCache) {
    if (processStateCache.size >= 1_024 && !processStateCache.has(pid)) {
      const oldest = processStateCache.keys().next().value as number | undefined;
      if (oldest !== undefined) processStateCache.delete(oldest);
    }
    processStateCache.set(pid, { checkedAt: Date.now(), alive });
  }
  return alive;
}

export function cancelSupervisedJob(pid: number): void {
  killProcessTreeByPid(pid, "SIGTERM", () => {
    try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
  });
}

export function startSupervisedJob(
  input: JobInput,
  inputPath: string,
  jobId = newId("job"),
  beforeSpawn?: (pending: JobState) => void,
): JobState {
  input = jobInputSchema.parse(input) as JobInput;
  assertJobControlPaths(input, inputPath);
  const inputDigest = fingerprint(input);
  writeJsonAtomic(inputPath, input);
  preflightStaleSupervisor(input.resultPath);
  const pending: JobState = { id: jobId, inputPath, inputDigest, resultPath: input.resultPath, startedAt: nowIso() };
  beforeSpawn?.(pending);
  const compiledEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
  const entry = process.env.AEC_S_CLI_ENTRY ?? (existsSync(compiledEntry) ? compiledEntry : process.argv[1]);
  if (!entry) throw new Error("Unable to locate AEC-S CLI entry for job supervisor");
  const child = spawn(process.execPath, [entry, "internal-job", inputPath, inputDigest], {
    detached: true,
    stdio: "ignore",
    env: childEnvironment(input.environmentProfile),
  });
  child.unref();
  return {
    ...pending,
    ...(child.pid ? { pid: child.pid } : {}),
  };
}

function readVerifiedJobResult(job: JobState): JobResult {
  const result = jobResultSchema.parse(readJson<unknown>(job.resultPath)) as JobResult;
  if (result.inputDigest !== job.inputDigest) {
    throw new Error(`Supervised JobResult integrity check failed: ${job.resultPath}`);
  }
  return result;
}

export async function waitForJob(
  job: JobState,
  timeoutSeconds: number,
  heartbeat?: () => void,
): Promise<JobResult> {
  const deadline = Date.now() + timeoutSeconds * 1_000 + 5_000;
  let nextHeartbeat = Date.now();
  while (Date.now() < deadline) {
    if (heartbeat && Date.now() >= nextHeartbeat) {
      heartbeat();
      nextHeartbeat = Date.now() + 10_000;
    }
    if (existsSync(job.resultPath) && (!job.pid || !processAlive(job.pid))) return readVerifiedJobResult(job);
    if (job.pid && !processAlive(job.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (existsSync(job.resultPath)) return readVerifiedJobResult(job);
      const input = readJson<JobInput>(job.inputPath);
      const stderr = existsSync(input.stderrPath) ? readFileSync(input.stderrPath, "utf8") : "";
      throw new Error(`Supervised job exited without result${stderr ? `: ${stderr.trim()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (job.pid && processAlive(job.pid)) {
    killProcessTreeByPid(job.pid, "SIGTERM", () => {
      try { process.kill(job.pid!, "SIGTERM"); return true; } catch { return false; }
    });
    const terminationDeadline = Date.now() + 2_500;
    while (Date.now() < terminationDeadline) {
      if (existsSync(job.resultPath) && !processAlive(job.pid)) return readVerifiedJobResult(job);
      if (!processAlive(job.pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processAlive(job.pid)) {
      killProcessTreeByPid(job.pid, "SIGKILL", () => {
        try { process.kill(job.pid!, "SIGKILL"); return true; } catch { return false; }
      });
    }
  }
  if (existsSync(job.resultPath) && (!job.pid || !processAlive(job.pid))) return readVerifiedJobResult(job);
  throw new Error(`Timed out waiting for supervised job ${job.id}`);
}
