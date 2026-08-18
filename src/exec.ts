import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { ChildEnvironmentProfile, CommandSpec } from "./types.js";
import { childEnvironment } from "./child-env.js";
import { killProcessTree } from "./process-control.js";

const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

export type ExecResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function execCommand(
  command: CommandSpec,
  stdin?: string,
  environmentProfile: ChildEnvironmentProfile = "restricted",
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      env: childEnvironment(environmentProfile, command.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
      forceKill.unref();
    }, (command.timeoutSeconds ?? 300) * 1_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      killProcessTree(child, "SIGKILL");
      resolve({ exitCode, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function execCommandToFile(command: CommandSpec, outputPath: string): Promise<ExecResult> {
  const child = spawn(command.program, command.args, {
    cwd: command.cwd,
    env: childEnvironment("restricted", command.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const output = createWriteStream(outputPath, { mode: 0o600 });
  let stderr: Buffer = Buffer.alloc(0);
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
  child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
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
      resolve({ exitCode, signal, stdout: "", stderr: stderr.toString("utf8"), timedOut });
    });
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CAPTURED_BYTES) callback(new Error("Command file output exceeds 8 MiB"));
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
  return writeError
    ? { ...result, exitCode: null, stderr: appendBounded(Buffer.from(result.stderr), Buffer.from(writeError.message)).toString("utf8") }
    : result;
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  const marker = Buffer.from("\n[output truncated]\n");
  if (current.length >= MAX_CAPTURED_BYTES) {
    if (current.subarray(-marker.length).equals(marker)) return current;
    const prefixLength = MAX_CAPTURED_BYTES - marker.length - 4;
    return Buffer.concat([current.subarray(0, prefixLength), marker], prefixLength + marker.length);
  }
  const remaining = MAX_CAPTURED_BYTES - current.length;
  if (chunk.length <= remaining) return Buffer.concat([current, chunk], current.length + chunk.length);
  if (remaining <= marker.length) return Buffer.concat([current, marker.subarray(0, remaining)], MAX_CAPTURED_BYTES);
  const contentLength = Math.max(0, remaining - marker.length - 4);
  return Buffer.concat([current, chunk.subarray(0, contentLength), marker], current.length + contentLength + marker.length);
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
