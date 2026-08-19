import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

export function killProcessTreeByPid(pid: number | undefined, signal: NodeJS.Signals, fallback: () => boolean): void {
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

type ProcessIdentity = { pid: number; parentPid: number; startedAt: string };

function processSnapshot(): ProcessIdentity[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 1_000 });
  if (result.error || result.status !== 0) return [];
  const processes: ProcessIdentity[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: match[3] });
  }
  return processes;
}

export function descendantProcessIds(rootPid: number | undefined): Map<number, string> {
  if (!rootPid || process.platform === "win32") return new Map();
  const children = new Map<number, ProcessIdentity[]>();
  for (const process of processSnapshot()) {
    const values = children.get(process.parentPid) ?? [];
    values.push(process);
    children.set(process.parentPid, values);
  }
  const found = new Map<number, string>();
  const pending = [rootPid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.set(child.pid, child.startedAt);
      pending.push(child.pid);
    }
  }
  return found;
}

export function killRecordedProcesses(pids: ReadonlyMap<number, string>, signal: NodeJS.Signals): void {
  const current = new Map(processSnapshot().map((process) => [process.pid, process.startedAt]));
  for (const [pid, startedAt] of pids) {
    if (current.get(pid) !== startedAt) continue;
    try { process.kill(pid, signal); } catch { /* Process already converged. */ }
  }
}
