import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
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
  mkdirSync(dirname(input.stdoutPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(input.stderrPath), { recursive: true, mode: 0o700 });
  const startedAt = nowIso();
  const stdout = openSync(input.stdoutPath, "a", 0o600);
  const stderr = openSync(input.stderrPath, "a", 0o600);
  let finished = false;
  const finish = (result: JobResult): void => {
    if (finished) return;
    finished = true;
    closeSync(stdout);
    closeSync(stderr);
    writeJsonAtomic(input.resultPath, result);
  };
  try {
    const child = spawn(input.command.program, input.command.args, {
      cwd: input.command.cwd,
      env: { ...process.env, ...input.command.env },
      stdio: ["pipe", stdout, stderr],
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      forceKill = setTimeout(() => killProcessTree(child.pid, "SIGKILL", () => child.kill("SIGKILL")), 2_000);
      forceKill.unref();
    }, (input.command.timeoutSeconds ?? 300) * 1_000);
    timeout.unref();
    child.on("error", (error) => {
      clearTimeout(timeout);
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
      if (forceKill) clearTimeout(forceKill);
      finish({ status: timedOut ? "timed_out" : "completed", exitCode, signal, startedAt, finishedAt: nowIso() });
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

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const cached = processStateCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < 1_000) return cached.alive;
  let alive = true;
  if (process.platform !== "win32") {
    const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const state = status.stdout.trim();
    alive = status.status === 0 && state.length > 0 && !state.startsWith("Z");
  }
  processStateCache.set(pid, { checkedAt: Date.now(), alive });
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

export function startSupervisedJob(input: JobInput, inputPath: string, jobId = newId("job")): JobState {
  writeJsonAtomic(inputPath, input);
  const compiledEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
  const entry = process.env.AEC_CLI_ENTRY ?? (existsSync(compiledEntry) ? compiledEntry : process.argv[1]);
  if (!entry) throw new Error("Unable to locate AEC CLI entry for job supervisor");
  const child = spawn(process.execPath, [entry, "internal-job", inputPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    id: jobId,
    inputPath,
    resultPath: input.resultPath,
    ...(child.pid ? { pid: child.pid } : {}),
    startedAt: nowIso(),
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
