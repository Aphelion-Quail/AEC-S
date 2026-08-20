#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

async function main(): Promise<void> {
  const [gatePath, program, ...args] = process.argv.slice(2);
  if (!gatePath || !program) throw new Error("AEC-S command gate requires a gate path and executable");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 8 * 1024 * 1024) throw new Error("AEC-S command gate input exceeds 8 MiB");
    chunks.push(value);
  }
  while (!existsSync(gatePath)) await new Promise((resolve) => setTimeout(resolve, 2));
  const child = spawn(program, args, { stdio: ["pipe", "inherit", "inherit"] });
  const input = Buffer.concat(chunks);
  let stdinError: Error | undefined;
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (input.length > 0 || error.code !== "EPIPE") stdinError = error;
  });
  child.stdin.end(input);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (stdinError) throw stdinError;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
