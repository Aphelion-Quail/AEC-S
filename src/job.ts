import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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
import { descendantProcessIds, killProcessTreeByPid, killRecordedProcesses } from "./process-control.js";
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
}

export async function runJobFile(inputPath: string, expectedDigest: string): Promise<void> {
  const input = jobInputSchema.parse(readJson<unknown>(inputPath)) as JobInput;
  assertJobControlPaths(input, inputPath);
  const inputDigest = fingerprint(input);
  if (expectedDigest.length !== 64 || inputDigest !== expectedDigest) {
    throw new Error(`Supervised JobInput integrity check failed: ${inputPath}`);
  }
  const supervisorLock = `${input.resultPath}.supervisor.lock`;
  let ownsSupervisorLock = false;
  const lockDeadline = Date.now() + (input.command.timeoutSeconds ?? 300) * 1_000 + 10_000;
  while (!ownsSupervisorLock) {
    if (existsSync(input.resultPath)) return;
    try {
      const lock = openSync(supervisorLock, "wx", 0o600);
      try { writeFileSync(lock, `${process.pid}\n`); } finally { closeSync(lock); }
      ownsSupervisorLock = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      let owner = 0;
      try { owner = Number(readFileSync(supervisorLock, "utf8").trim()); }
      catch { continue; }
      if (!Number.isInteger(owner) || owner <= 0 || !processAlive(owner)) {
        try { unlinkSync(supervisorLock); } catch { /* Another reconciler won. */ }
        continue;
      }
      if (Date.now() >= lockDeadline) throw new Error(`Timed out waiting for existing supervisor ${owner}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  mkdirSync(dirname(input.stdoutPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(input.stderrPath), { recursive: true, mode: 0o700 });
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
    if (ownsSupervisorLock) {
      try { unlinkSync(supervisorLock); } catch { /* Result is already durable. */ }
    }
  };
  try {
    const environmentProfile = input.environmentProfile ?? "restricted";
    const launch = isolatedCommand(input.command, input.isolation, environmentProfile);
    const isolationOverrides = isolationEnvironment(input.isolation, environmentProfile);
    const child = spawn(launch.program, launch.args, {
      cwd: launch.cwd,
      env: childEnvironment(environmentProfile, { ...input.command.env, ...isolationOverrides }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const observedDescendants = new Map<number, string>();
    const recordDescendants = (): void => {
      for (const [pid, startedAt] of descendantProcessIds(child.pid)) observedDescendants.set(pid, startedAt);
    };
    recordDescendants();
    const descendantCensus = setInterval(recordDescendants, 50);
    descendantCensus.unref();
    let timedOut = false;
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
    child.on("close", (exitCode, signal) => {
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
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      finish({
        status: stdinError ? "spawn_error" : outputLimitExceeded ? "output_limit" : timedOut ? "timed_out" : sandboxDenied && exitCode !== 0 ? "sandbox_denied" : "completed",
        exitCode,
        signal,
        ...(stdinError ? { error: `Failed to deliver supervised Job input: ${stdinError}` } : outputLimitExceeded ? { error: outputLimitExceeded } : {}),
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
