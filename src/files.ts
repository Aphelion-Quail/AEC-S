import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function parseStructuredOutput<T>(path: string): T {
  const text = readFileSync(path, "utf8").trim();
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
