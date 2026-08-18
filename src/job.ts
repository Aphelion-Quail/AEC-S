import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type { JobInput, JobResult, JobState } from "./types.js";
import { newId, nowIso } from "./ids.js";
import { readJson, writeJsonAtomic } from "./files.js";
import { jobInputSchema } from "./input.js";

export async function runJobFile(inputPath: string): Promise<void> {
  const input = jobInputSchema.parse(readJson<unknown>(inputPath)) as JobInput;
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
  const outputLimit = 8 * 1024 * 1024;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const finish = (result: JobResult): void => {
    if (finished) return;
    finished = true;
    closeSync(stdout);
    closeSync(stderr);
    writeJsonAtomic(input.resultPath, result);
    if (ownsSupervisorLock) {
      try { unlinkSync(supervisorLock); } catch { /* Result is already durable. */ }
    }
  };
  try {
    const child = spawn(input.command.program, input.command.args, {
      cwd: input.command.cwd,
      env: { ...process.env, ...input.command.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let terminateTree: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const forwardCancellation = (): void => {
      // Signal the controlled Runtime entrypoint first so protocol-aware
      // adapters can issue session/cancel or close their composition cleanly.
      // A bounded process-group kill remains the deterministic backstop.
      child.kill("SIGTERM");
      if (!terminateTree) {
        terminateTree = setTimeout(() => killProcessTree(child.pid, "SIGTERM", () => child.kill("SIGTERM")), 250);
        terminateTree.unref();
      }
      if (!forceKill) {
        forceKill = setTimeout(() => killProcessTree(child.pid, "SIGKILL", () => child.kill("SIGKILL")), 2_000);
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
    child.stderr!.on("data", (chunk: Buffer) => writeBounded(stderr, chunk, "stderr"));
    const onSignal = (): void => forwardCancellation();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    const timeout = setTimeout(() => {
      timedOut = true;
      forwardCancellation();
    }, (input.command.timeoutSeconds ?? 300) * 1_000);
    timeout.unref();
    child.on("error", (error) => {
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
      clearTimeout(timeout);
      if (terminateTree) clearTimeout(terminateTree);
      if (forceKill) clearTimeout(forceKill);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      finish({
        status: outputLimitExceeded ? "output_limit" : timedOut ? "timed_out" : "completed",
        exitCode,
        signal,
        ...(outputLimitExceeded ? { error: outputLimitExceeded } : {}),
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
  if (useCache) processStateCache.set(pid, { checkedAt: Date.now(), alive });
  return alive;
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals, fallback: () => boolean): void {
  if (!pid || process.platform === "win32") {
    fallback();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
  }
}

export function startSupervisedJob(
  input: JobInput,
  inputPath: string,
  jobId = newId("job"),
  beforeSpawn?: (pending: JobState) => void,
): JobState {
  writeJsonAtomic(inputPath, input);
  const pending: JobState = { id: jobId, inputPath, resultPath: input.resultPath, startedAt: nowIso() };
  beforeSpawn?.(pending);
  const compiledEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
  const entry = process.env.AEC_S_CLI_ENTRY ?? (existsSync(compiledEntry) ? compiledEntry : process.argv[1]);
  if (!entry) throw new Error("Unable to locate AEC-S CLI entry for job supervisor");
  const child = spawn(process.execPath, [entry, "internal-job", inputPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    ...pending,
    ...(child.pid ? { pid: child.pid } : {}),
  };
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
    if (existsSync(job.resultPath)) return readJson<JobResult>(job.resultPath);
    if (job.pid && !processAlive(job.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (existsSync(job.resultPath)) return readJson<JobResult>(job.resultPath);
      const input = readJson<JobInput>(job.inputPath);
      const stderr = existsSync(input.stderrPath) ? readFileSync(input.stderrPath, "utf8") : "";
      throw new Error(`Supervised job exited without result${stderr ? `: ${stderr.trim()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for supervised job ${job.id}`);
}
