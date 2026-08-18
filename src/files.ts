import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temp, "w", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function assertFileSize(path: string, maxBytes = 8 * 1024 * 1024, label = "File"): void {
  if (statSync(path).size > maxBytes) throw new Error(`${label} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB: ${path}`);
}

export function readTextBounded(path: string, maxBytes = 8 * 1024 * 1024, label = "File"): string {
  assertFileSize(path, maxBytes, label);
  return readFileSync(path, "utf8");
}

export function parseStructuredOutput<T>(path: string): T {
  const text = readTextBounded(path, 8 * 1024 * 1024, "Structured output").trim();
  if (!text) throw new Error(`Structured output is empty: ${path}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line) as T;
      } catch {
        // Continue looking for the final JSON object.
      }
    }
    throw new Error(`No JSON object found in ${path}`);
  }
}
