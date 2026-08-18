import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Project, Task } from "./types.js";
import { execChecked, execCommand, execCommandToFile } from "./exec.js";
import { matchesAny } from "./glob.js";

const projectLocks = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 10 * 60 * 1_000;
const LOCK_LEASE_MS = 30 * 60 * 1_000;

export async function withProjectGitLock<T>(project: Project, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(project.id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const queued = previous.then(() => current);
  projectLocks.set(project.id, queued);
  await previous;
  let lock: { databasePath: string; token: string } | undefined;
  try {
    lock = await acquireProjectFileLock(project);
    return await fn();
  } finally {
    // Always release the in-process queue first. A SQLite release failure must
    // be visible to the caller, but it cannot be allowed to strand every later
    // Git operation for this Project behind an unresolved Promise.
    release();
    if (projectLocks.get(project.id) === queued) projectLocks.delete(project.id);
    if (lock) releaseProjectFileLock(lock);
  }
}

async function acquireProjectFileLock(project: Project): Promise<{ databasePath: string; token: string }> {
  const databasePath = await projectLockDatabasePath(project);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const lockDb = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  lockDb.exec("PRAGMA busy_timeout=1000");
  lockDb.exec(`CREATE TABLE IF NOT EXISTS project_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT,
    pid INTEGER,
    lease_until INTEGER
  )`);
  lockDb.prepare("INSERT OR IGNORE INTO project_lock(id, owner, pid, lease_until) VALUES (1, NULL, NULL, NULL)").run();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      let transactionOpen = false;
      try {
        lockDb.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const row = lockDb.prepare("SELECT owner, pid, lease_until FROM project_lock WHERE id=1").get() as
          | { owner: string | null; pid: number | null; lease_until: number | null }
          | undefined;
        const expired = !row?.owner || !row.lease_until || row.lease_until <= Date.now();
        const dead = row?.pid ? !processIsAlive(row.pid) : true;
        if (expired || dead) {
          lockDb.prepare("UPDATE project_lock SET owner=?, pid=?, lease_until=? WHERE id=1")
            .run(token, process.pid, Date.now() + LOCK_LEASE_MS);
          lockDb.exec("COMMIT");
          transactionOpen = false;
          lockDb.close();
          return { databasePath, token };
        }
        lockDb.exec("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) {
          try { lockDb.exec("ROLLBACK"); } catch { /* connection may already have rolled back */ }
        }
        const code = (error as { code?: string }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
    }
  } finally {
    try {
      lockDb.close();
    } catch { /* already closed after successful acquisition */ }
  }
  throw new Error(`Timed out waiting for Project Git lock: ${project.id}`);
}

export async function projectLockDatabasePath(project: Project): Promise<string> {
  const commonDirValue = await execChecked(git(project.repoPath, ["rev-parse", "--git-common-dir"]));
  const commonDir = isAbsolute(commonDirValue) ? commonDirValue : resolve(project.repoPath, commonDirValue);
  const canonicalCommonDir = realpathSync(commonDir);
  mkdirSync(canonicalCommonDir, { recursive: true, mode: 0o700 });
  return join(canonicalCommonDir, "aec-s-project-git-lock.sqlite");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const inspected = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
    if (inspected.error || inspected.status !== 0 || !inspected.stdout.trim()) return true;
    return !inspected.stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}

function releaseProjectFileLock(lock: { databasePath: string; token: string }): void {
  const lockDb = new DatabaseSync(lock.databasePath);
  try {
    lockDb.exec("PRAGMA busy_timeout=5000");
    lockDb.prepare("UPDATE project_lock SET owner=NULL, pid=NULL, lease_until=NULL WHERE id=1 AND owner=?").run(lock.token);
  } finally {
    lockDb.close();
  }
}

function git(cwd: string, args: string[], timeoutSeconds = 120) {
  return { program: "git", args, cwd, timeoutSeconds };
}

export function projectBaseRef(project: Project): string {
  return project.deliveryMode === "github" ? `${project.remoteName}/${project.targetBranch}` : project.targetBranch;
}

export async function assertGitRepository(repoPath: string): Promise<void> {
  const result = await execCommand(git(repoPath, ["rev-parse", "--git-dir"]));
  if (result.exitCode !== 0) throw new Error(`Not a Git repository: ${repoPath}`);
}

export async function branchHead(repoPath: string, branch: string): Promise<string> {
  return await execChecked(git(repoPath, ["rev-parse", branch]));
}

export async function currentBranch(repoPath: string): Promise<string> {
  return await execChecked(git(repoPath, ["branch", "--show-current"]));
}

export async function createWorktree(
  project: Project,
  workspacePath: string,
  branch: string,
): Promise<string> {
  return await withProjectGitLock(project, async () => {
    await assertGitRepository(project.repoPath);
    if (project.deliveryMode === "github") await execChecked(git(project.repoPath, ["fetch", project.remoteName, project.targetBranch], 300));
    const baseRef = projectBaseRef(project);
    const baseSha = await branchHead(project.repoPath, baseRef);
    if (existsSync(join(workspacePath, ".git"))) {
      // A recovered worktree may predate the current target HEAD. Its merge-base
      // is the source fact for the existing diff; returning the new target here
      // would silently fold unrelated commits into the task.
      return await execChecked(git(workspacePath, ["merge-base", "HEAD", baseRef]));
    }
    const branchExists = (await execCommand(git(project.repoPath, ["show-ref", "--verify", `refs/heads/${branch}`]))).exitCode === 0;
    const args = branchExists
      ? ["worktree", "add", workspacePath, branch]
      : ["worktree", "add", "-b", branch, workspacePath, baseRef];
    await execChecked(git(project.repoPath, args));
    return baseSha;
  });
}

export async function changedPaths(workspacePath: string, baseSha: string): Promise<string[]> {
  const tracked = await execCommand(git(workspacePath, ["diff", "--name-only", "-z", baseSha, "--"]));
  if (tracked.exitCode !== 0) throw new Error(tracked.stderr.trim() || "Unable to inspect changed paths");
  const status = await execCommand(
    git(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (status.exitCode !== 0) throw new Error(status.stderr.trim() || "Unable to inspect workspace status");
  const paths = new Set<string>();
  for (const path of tracked.stdout.split("\0")) if (path) paths.add(path);
  const entries = status.stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.add(path);
    if (code.includes("R") || code.includes("C")) {
      const sourcePath = entries[index + 1];
      if (sourcePath) paths.add(sourcePath);
      index += 1;
    }
  }
  return [...paths].sort();
}

export async function workspaceHasChanges(workspacePath: string): Promise<boolean> {
  const result = await execCommand(
    git(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to inspect workspace status");
  return result.stdout.length > 0;
}

export async function restoreWorkspaceHead(workspacePath: string): Promise<void> {
  await execChecked(git(workspacePath, ["reset", "--hard", "HEAD"]));
  await execChecked(git(workspacePath, ["clean", "-fd"]));
}

export async function changedPathsBetween(repoPath: string, fromSha: string, toSha: string): Promise<string[]> {
  if (fromSha === toSha) return [];
  const result = await execCommand(git(repoPath, ["diff", "--name-only", "-z", `${fromSha}..${toSha}`, "--"]));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to inspect target changes");
  return result.stdout.split("\0").filter(Boolean).sort();
}

export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await execCommand(git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]));
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(result.stderr.trim() || `Unable to compare Git ancestry for ${ancestor} and ${descendant}`);
}

export async function mergeBase(repoPath: string, left: string, right: string): Promise<string> {
  return await execChecked(git(repoPath, ["merge-base", left, right]));
}

export async function commitCountBetween(repoPath: string, fromSha: string, toSha: string): Promise<number> {
  const value = await execChecked(git(repoPath, ["rev-list", "--count", `${fromSha}..${toSha}`]));
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid Git commit count: ${value}`);
  return count;
}

export function outOfScopePaths(task: Task, paths: string[]): string[] {
  if (task.scope.writeGlobs.length === 0) return [];
  return paths.filter((path) => !matchesAny(path, task.scope.writeGlobs));
}

export function changesAffectTask(task: Task, paths: string[]): boolean {
  const relevant = [...task.scope.writeGlobs, ...(task.scope.watchGlobs ?? task.scope.impactGlobs ?? [])];
  if (relevant.length === 0) return true;
  return paths.some((path) => matchesAny(path, relevant));
}

export async function writeDiff(workspacePath: string, baseSha: string, outputPath: string): Promise<void> {
  await execChecked(git(workspacePath, ["add", "--all"]));
  const result = await execCommandToFile(
    git(workspacePath, ["diff", "--cached", "--binary", baseSha, "--"]),
    outputPath,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to write task diff");
}

export async function commitTask(workspacePath: string, task: Task): Promise<string> {
  await execChecked(git(workspacePath, ["add", "--all"]));
  const staged = await execCommand(git(workspacePath, ["diff", "--cached", "--quiet"]));
  if (staged.exitCode === 0) {
    const existing = await execCommand(git(workspacePath, ["log", "-1", "--format=%B"]));
    if (existing.exitCode === 0 && existing.stdout.includes(`AEC-S-Task: ${task.id}`)) {
      return await branchHead(workspacePath, "HEAD");
    }
    throw new Error("Task produced no changes to commit");
  }
  await execChecked({
    ...git(workspacePath, [
      "-c",
      "user.name=AEC-S",
      "-c",
      "user.email=aec-s@local",
      "commit",
      "-m",
      task.title,
      "-m",
      `AEC-S-Task: ${task.id}`,
    ]),
    timeoutSeconds: 300,
  });
  return await branchHead(workspacePath, "HEAD");
}

export async function revertMergedTask(project: Project, mergeSha: string, taskId: string): Promise<string> {
  return await withProjectGitLock(project, async () => {
    if (project.deliveryMode !== "local") throw new Error("Automatic revert is currently limited to local delivery");
    const targetHead = await branchHead(project.repoPath, project.targetBranch);
    if (targetHead !== mergeSha) {
      const parent = await execCommand(git(project.repoPath, ["rev-parse", `${targetHead}^`]));
      const message = await execCommand(git(project.repoPath, ["log", "-1", "--format=%B", targetHead]));
      if (parent.exitCode === 0 && parent.stdout.trim() === mergeSha &&
          message.exitCode === 0 && message.stdout.includes(`This reverts commit ${mergeSha}`)) return targetHead;
      throw new Error("Automatic revert requires the failed merge or its reconciled revert to remain the exact target HEAD");
    }
    try {
      await execChecked(git(project.repoPath, [
        "-c", "user.name=AEC-S", "-c", "user.email=aec-s@local",
        "revert", "--no-edit", mergeSha,
      ], 300));
    } catch (error) {
      await execCommand(git(project.repoPath, ["revert", "--abort"]));
      throw error;
    }
    const reverted = await branchHead(project.repoPath, project.targetBranch);
    const message = await execChecked(git(project.repoPath, ["log", "-1", "--format=%B"]));
    if (!message.includes(`Revert`) || !message.includes(mergeSha.slice(0, 7))) {
      throw new Error(`Revert commit for ${taskId} could not be reconciled`);
    }
    return reverted;
  });
}

export async function verifyMergedRevision(project: Project, workspacePath: string, mergeSha: string): Promise<void> {
  if (project.deliveryMode === "github") {
    await fetchRemote(project);
    const ancestor = await execCommand(git(project.repoPath, ["merge-base", "--is-ancestor", mergeSha, projectBaseRef(project)]));
    if (ancestor.exitCode !== 0) throw new Error(`Merge SHA ${mergeSha} is not on the observed target branch`);
    const workspaceTree = await execChecked(git(workspacePath, ["rev-parse", "HEAD^{tree}"]));
    const mergedTree = await execChecked(git(project.repoPath, ["rev-parse", `${mergeSha}^{tree}`]));
    if (workspaceTree !== mergedTree) throw new Error(`Workspace tree does not represent merge SHA ${mergeSha}`);
    return;
  }
  const ancestor = await execCommand(git(project.repoPath, ["merge-base", "--is-ancestor", mergeSha, project.targetBranch]));
  if (ancestor.exitCode !== 0) throw new Error(`Merge SHA ${mergeSha} is not on the local target branch`);
  const workspaceTree = await execChecked(git(workspacePath, ["rev-parse", "HEAD^{tree}"]));
  const mergedTree = await execChecked(git(project.repoPath, ["rev-parse", `${mergeSha}^{tree}`]));
  if (workspaceTree !== mergedTree) throw new Error(`Workspace tree does not represent local merge SHA ${mergeSha}`);
}

export async function rebaseOntoTarget(project: Project, workspacePath: string): Promise<string> {
  return await withProjectGitLock(project, async () => {
    const targetHead = await branchHead(project.repoPath, projectBaseRef(project));
    await execChecked({ ...git(workspacePath, ["rebase", targetHead]), timeoutSeconds: 300 });
    return targetHead;
  });
}

export async function continueRebase(workspacePath: string): Promise<void> {
  await execChecked({
    ...git(workspacePath, ["-c", "core.editor=true", "rebase", "--continue"]),
    env: { GIT_EDITOR: "true" },
    timeoutSeconds: 300,
  });
}

export async function rebaseInProgress(workspacePath: string): Promise<boolean> {
  const mergePath = await execChecked(git(workspacePath, ["rev-parse", "--git-path", "rebase-merge"]));
  const applyPath = await execChecked(git(workspacePath, ["rev-parse", "--git-path", "rebase-apply"]));
  const absoluteMergePath = isAbsolute(mergePath) ? mergePath : resolve(workspacePath, mergePath);
  const absoluteApplyPath = isAbsolute(applyPath) ? applyPath : resolve(workspacePath, applyPath);
  return existsSync(absoluteMergePath) || existsSync(absoluteApplyPath);
}

export async function localMerge(project: Project, branch: string, expectedTaskSha: string): Promise<string> {
  return await withProjectGitLock(project, async () => {
    const currentHead = await branchHead(project.repoPath, project.targetBranch);
    if (currentHead === expectedTaskSha) return currentHead;
    const checkedOut = await currentBranch(project.repoPath);
    if (checkedOut !== project.targetBranch) {
      throw new Error(`Local delivery requires ${project.targetBranch} to be checked out in ${project.repoPath}`);
    }
    const status = await execChecked(git(project.repoPath, ["status", "--porcelain"]));
    if (status) throw new Error(`Project working tree is not clean: ${project.repoPath}`);
    await execChecked({ ...git(project.repoPath, ["merge", "--ff-only", branch]), timeoutSeconds: 300 });
    return await branchHead(project.repoPath, project.targetBranch);
  });
}

export async function cleanupWorktree(project: Project, workspacePath: string, branch?: string): Promise<void> {
  await withProjectGitLock(project, async () => {
    if (existsSync(workspacePath)) {
      await execChecked(git(project.repoPath, ["worktree", "remove", "--force", workspacePath]));
    }
    await execCommand(git(project.repoPath, ["worktree", "prune"]));
    if (branch) await execCommand(git(project.repoPath, ["branch", "-D", branch]));
  });
}

export async function fetchRemote(project: Project): Promise<void> {
  if (!project.remoteName) return;
  await withProjectGitLock(project, async () => {
    await fetchRemoteUnlocked(project);
  });
}

export async function fetchRemoteUnlocked(project: Project): Promise<void> {
  if (!project.remoteName) return;
  await execChecked({ ...git(project.repoPath, ["fetch", project.remoteName, project.targetBranch]), timeoutSeconds: 300 });
}
