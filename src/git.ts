import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Project, Task } from "./types.js";
import { execChecked, execCommand } from "./exec.js";
import { matchesAny } from "./glob.js";

const projectLocks = new Map<string, Promise<void>>();

export async function withProjectGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const queued = previous.then(() => current);
  projectLocks.set(projectId, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (projectLocks.get(projectId) === queued) projectLocks.delete(projectId);
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
  return await withProjectGitLock(project.id, async () => {
    await assertGitRepository(project.repoPath);
    if (project.deliveryMode === "github") await execChecked(git(project.repoPath, ["fetch", project.remoteName, project.targetBranch], 300));
    const baseRef = projectBaseRef(project);
    const baseSha = await branchHead(project.repoPath, baseRef);
    if (existsSync(join(workspacePath, ".git"))) return baseSha;
    const branchExists = (await execCommand(git(project.repoPath, ["show-ref", "--verify", `refs/heads/${branch}`]))).exitCode === 0;
    const args = branchExists
      ? ["worktree", "add", workspacePath, branch]
      : ["worktree", "add", "-b", branch, workspacePath, baseRef];
    await execChecked(git(project.repoPath, args));
    return baseSha;
  });
}

export async function changedPaths(workspacePath: string, baseSha: string): Promise<string[]> {
  const tracked = await execChecked(git(workspacePath, ["diff", "--name-only", baseSha, "--"]));
  const status = await execChecked(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]));
  const paths = new Set<string>();
  for (const line of tracked.split(/\r?\n/)) if (line.trim()) paths.add(line.trim());
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const value = line.slice(3).trim();
    const path = value.includes(" -> ") ? value.split(" -> ").at(-1)! : value;
    paths.add(path.replace(/^"|"$/g, ""));
  }
  return [...paths].sort();
}

export async function changedPathsBetween(repoPath: string, fromSha: string, toSha: string): Promise<string[]> {
  if (fromSha === toSha) return [];
  const output = await execChecked(git(repoPath, ["diff", "--name-only", `${fromSha}..${toSha}`, "--"]));
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort();
}

export function outOfScopePaths(task: Task, paths: string[]): string[] {
  if (task.scope.writeGlobs.length === 0) return paths;
  return paths.filter((path) => !matchesAny(path, task.scope.writeGlobs));
}

export function changesAffectTask(task: Task, paths: string[]): boolean {
  const relevant = [...task.scope.writeGlobs, ...task.scope.impactGlobs];
  if (relevant.length === 0) return true;
  return paths.some((path) => matchesAny(path, relevant));
}

export async function writeDiff(workspacePath: string, baseSha: string): Promise<string> {
  await execChecked(git(workspacePath, ["add", "--all"]));
  return await execChecked(git(workspacePath, ["diff", "--cached", "--binary", baseSha, "--"]));
}

export async function commitTask(workspacePath: string, task: Task): Promise<string> {
  const existing = await execCommand(git(workspacePath, ["log", "-1", "--format=%B"]));
  if (existing.exitCode === 0 && existing.stdout.includes(`AEC-Task: ${task.id}`)) {
    return await branchHead(workspacePath, "HEAD");
  }
  await execChecked(git(workspacePath, ["add", "--all"]));
  const staged = await execCommand(git(workspacePath, ["diff", "--cached", "--quiet"]));
  if (staged.exitCode === 0) throw new Error("Task produced no changes to commit");
  await execChecked({
    ...git(workspacePath, [
      "-c",
      "user.name=AEC",
      "-c",
      "user.email=aec@local",
      "commit",
      "-m",
      task.title,
      "-m",
      `AEC-Task: ${task.id}`,
    ]),
    timeoutSeconds: 300,
  });
  return await branchHead(workspacePath, "HEAD");
}

export async function rebaseOntoTarget(project: Project, workspacePath: string): Promise<void> {
  await withProjectGitLock(project.id, async () => {
    await execChecked({ ...git(workspacePath, ["rebase", projectBaseRef(project)]), timeoutSeconds: 300 });
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

export async function abortRebase(workspacePath: string): Promise<void> {
  await execCommand(git(workspacePath, ["rebase", "--abort"]));
}

export async function localMerge(project: Project, branch: string, expectedTaskSha: string): Promise<string> {
  return await withProjectGitLock(project.id, async () => {
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
  await withProjectGitLock(project.id, async () => {
    if (existsSync(workspacePath)) {
      await execChecked(git(project.repoPath, ["worktree", "remove", "--force", workspacePath]));
    }
    await execCommand(git(project.repoPath, ["worktree", "prune"]));
    if (branch) await execCommand(git(project.repoPath, ["branch", "-D", branch]));
  });
}

export async function fetchRemote(project: Project): Promise<void> {
  if (!project.remoteName) return;
  await withProjectGitLock(project.id, async () => {
    await execChecked({ ...git(project.repoPath, ["fetch", project.remoteName, project.targetBranch]), timeoutSeconds: 300 });
  });
}
