import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { CommandSpec } from "./types.js";

const MAX_CAPTURED_CHARACTERS = 8 * 1024 * 1024;

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group is gone.
    }
  }
  child.kill(signal);
}

export type ExecResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function execCommand(command: CommandSpec, stdin?: string): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
      forceKill.unref();
    }, (command.timeoutSeconds ?? 300) * 1_000);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout = appendBounded(stdout, chunk)));
    child.stderr.on("data", (chunk: string) => (stderr = appendBounded(stderr, chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      killProcessTree(child, "SIGKILL");
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function execCommandToFile(command: CommandSpec, outputPath: string): Promise<ExecResult> {
  const child = spawn(command.program, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const output = createWriteStream(outputPath, { mode: 0o600 });
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  let forceKill: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, "SIGTERM");
    forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
    forceKill.unref();
  }, (command.timeoutSeconds ?? 300) * 1_000);
  timeout.unref();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = appendBounded(stderr, chunk)));
  const completed = new Promise<ExecResult>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      output.destroy(error);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      killProcessTree(child, "SIGKILL");
      resolve({ exitCode, signal, stdout: "", stderr, timedOut });
    });
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CAPTURED_CHARACTERS) callback(new Error("Command file output exceeds 8 MiB"));
      else callback(null, chunk);
    },
  });
  const writing = pipeline(child.stdout, limiter, output).then(
    () => undefined,
    (error: unknown) => {
      killProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
      forceKill.unref();
      return error instanceof Error ? error : new Error(String(error));
    },
  );
  const [result, writeError] = await Promise.all([completed, writing]);
  return writeError ? { ...result, exitCode: null, stderr: appendBounded(stderr, writeError.message) } : result;
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURED_CHARACTERS) return current;
  const remaining = MAX_CAPTURED_CHARACTERS - current.length;
  if (chunk.length <= remaining) return current + chunk;
  const marker = "\n[output truncated]\n";
  return `${current}${chunk.slice(0, Math.max(0, remaining - marker.length))}${marker}`;
}

export async function execChecked(command: CommandSpec, stdin?: string): Promise<string> {
  const result = await execCommand(command, stdin);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${command.program} ${command.args.join(" ")}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}
