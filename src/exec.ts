import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { ChildEnvironmentProfile, InternalCommandSpec } from "./types.js";
import { childEnvironment } from "./child-env.js";
import { killProcessTree } from "./process-control.js";

const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER = Buffer.from("\n[output truncated]\n");
// Leave enough raw-byte headroom for a replacement character when a bounded
// capture ends in the middle of an invalid UTF-8 sequence. This keeps the
// returned string within the same byte limit after decoding.
const UTF8_REPLACEMENT_HEADROOM = 4;

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  append(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = MAX_CAPTURED_BYTES - this.bytes;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return;
    }
    if (remaining > 0) {
      // Copy the retained prefix so a single oversized stream chunk cannot
      // keep an arbitrarily large backing buffer alive until process exit.
      this.chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      this.bytes += remaining;
    }
    this.truncated = true;
  }

  text(): string {
    const captured = Buffer.concat(this.chunks, this.bytes);
    const value = captured.toString("utf8");
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (!this.truncated && valueBytes <= MAX_CAPTURED_BYTES) return value;
    const prefixBytes = Math.max(
      0,
      MAX_CAPTURED_BYTES - OUTPUT_TRUNCATION_MARKER.length - UTF8_REPLACEMENT_HEADROOM,
    );
    if (valueBytes <= prefixBytes) return `${value}${OUTPUT_TRUNCATION_MARKER.toString("utf8")}`;
    // `captured` may contain arbitrary bytes. Decode and re-encode before
    // slicing so invalid input cannot expand beyond the byte ceiling through
    // repeated U+FFFD replacement characters.
    const encoded = Buffer.from(value, "utf8");
    return `${encoded.subarray(0, prefixBytes).toString("utf8")}${OUTPUT_TRUNCATION_MARKER.toString("utf8")}`;
  }
}

export type ExecResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function execCommand(
  command: InternalCommandSpec,
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
    const stdout = new BoundedCapture();
    const stderr = new BoundedCapture();
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
      forceKill.unref();
    }, (command.timeoutSeconds ?? 300) * 1_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      killProcessTree(child, "SIGKILL");
      resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function execCommandToFile(command: InternalCommandSpec, outputPath: string): Promise<ExecResult> {
  const child = spawn(command.program, command.args, {
    cwd: command.cwd,
    env: childEnvironment("restricted", command.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const output = createWriteStream(outputPath, { mode: 0o600 });
  const stderr = new BoundedCapture();
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
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
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
      resolve({ exitCode, signal, stdout: "", stderr: stderr.text(), timedOut });
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
    ? { ...result, exitCode: null, stderr: appendCapturedText(result.stderr, writeError.message) }
    : result;
}

function appendCapturedText(current: string, suffix: string): string {
  const capture = new BoundedCapture();
  capture.append(Buffer.from(current));
  capture.append(Buffer.from(suffix));
  return capture.text();
}

export async function execChecked(command: InternalCommandSpec, stdin?: string): Promise<string> {
  const result = await execCommand(command, stdin);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${command.program} ${command.args.join(" ")}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}
