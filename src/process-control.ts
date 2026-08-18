import type { ChildProcess } from "node:child_process";

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
