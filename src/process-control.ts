import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import koffi from "koffi";

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const PROC_BSDINFO_STATUS_OFFSET = 4;
const PROC_BSDINFO_PID_OFFSET = 12;
const PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
const PROC_STATUS_ZOMBIE = 5;

type NativeFunction = (...args: unknown[]) => number;

const libproc = process.platform === "darwin" ? koffi.load("/usr/lib/libproc.dylib") : undefined;
const procListChildPids = libproc?.func("int proc_listchildpids(int, void *, int)") as NativeFunction | undefined;
const procPidInfo = libproc?.func("int proc_pidinfo(int, int, uint64, void *, int)") as NativeFunction | undefined;

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

function darwinProcessIdentity(pid: number): string | undefined {
  if (!procPidInfo) throw new Error("macOS libproc process identity is unavailable");
  const buffer = Buffer.alloc(PROC_BSDINFO_SIZE);
  const size = procPidInfo(pid, PROC_PIDTBSDINFO, 0, buffer, buffer.length);
  if (size === 0) return undefined;
  if (size !== PROC_BSDINFO_SIZE || buffer.readUInt32LE(PROC_BSDINFO_PID_OFFSET) !== pid) {
    throw new Error(`macOS libproc returned an invalid process identity for PID ${pid}`);
  }
  if (buffer.readUInt32LE(PROC_BSDINFO_STATUS_OFFSET) === PROC_STATUS_ZOMBIE) return undefined;
  return `${buffer.readBigUInt64LE(PROC_BSDINFO_START_SECONDS_OFFSET)}:${buffer.readBigUInt64LE(PROC_BSDINFO_START_MICROSECONDS_OFFSET)}`;
}

function darwinChildPids(pid: number): number[] {
  if (!procListChildPids) throw new Error("macOS libproc child tracking is unavailable");
  const count = procListChildPids(pid, null, 0);
  if (count < 0) throw new Error(`macOS libproc could not enumerate children of PID ${pid}`);
  if (count === 0) return [];
  const buffer = Buffer.alloc(count * 4);
  const written = procListChildPids(pid, buffer, buffer.length);
  if (written < 0 || written > count) throw new Error(`macOS libproc returned an invalid child count for PID ${pid}`);
  return Array.from({ length: written }, (_, index) => buffer.readInt32LE(index * 4)).filter((child) => child > 0);
}

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
  if (process.platform === "darwin") {
    const found = new Map<number, string>();
    const pending = [rootPid];
    const seen = new Set(pending);
    let cursor = 0;
    while (cursor < pending.length) {
      const parent = pending[cursor++]!;
      for (const child of darwinChildPids(parent)) {
        if (seen.has(child)) continue;
        seen.add(child);
        const identity = darwinProcessIdentity(child);
        if (!identity) continue;
        found.set(child, identity);
        pending.push(child);
      }
    }
    return found;
  }
  const children = new Map<number, ProcessIdentity[]>();
  for (const process of processSnapshot()) {
    const values = children.get(process.parentPid) ?? [];
    values.push(process);
    children.set(process.parentPid, values);
  }
  const found = new Map<number, string>();
  const pending = [rootPid];
  const seen = new Set(pending);
  let cursor = 0;
  while (cursor < pending.length) {
    const parent = pending[cursor++]!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.set(child.pid, child.startedAt);
      pending.push(child.pid);
    }
  }
  return found;
}

export function processIdentity(pid: number): string | undefined {
  if (process.platform === "darwin") return darwinProcessIdentity(pid);
  return processSnapshot().find((process) => process.pid === pid)?.startedAt;
}

export function processMatchesIdentity(pid: number, startedAt: string): boolean {
  return processIdentity(pid) === startedAt;
}

export function killRecordedProcesses(pids: ReadonlyMap<number, string>, signal: NodeJS.Signals): number[] {
  const current = process.platform === "darwin"
    ? new Map([...pids.keys()].map((pid) => [pid, darwinProcessIdentity(pid)]))
    : new Map(processSnapshot().map((process) => [process.pid, process.startedAt]));
  const survivors: number[] = [];
  for (const [pid, startedAt] of pids) {
    if (current.get(pid) !== startedAt) continue;
    try {
      process.kill(pid, signal);
      survivors.push(pid);
    } catch { /* Process already converged. */ }
  }
  return survivors;
}
