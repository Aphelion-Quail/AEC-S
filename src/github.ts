import type { Project, Task } from "./types.js";
import { execChecked, execCommand } from "./exec.js";
import { withProjectGitLock } from "./git.js";
import { AEC_ERROR, AecError } from "./errors.js";

type PullRequest = {
  number: number;
  url: string;
  state: string;
  headRefOid?: string;
  mergeCommit?: { oid?: string } | null;
};

function gh(cwd: string, args: string[], timeoutSeconds = 300) {
  return { program: "gh", args, cwd, timeoutSeconds };
}

function git(cwd: string, args: string[], timeoutSeconds = 300) {
  return { program: "git", args, cwd, timeoutSeconds };
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Invalid JSON from ${label}: ${value.slice(0, 500)}`);
  }
}

export function githubCheckPollIntervalMs(value = process.env.AEC_S_GITHUB_CHECK_POLL_MS): number {
  if (value === undefined || value.trim() === "") return 5_000;
  const interval = Number(value);
  return Number.isFinite(interval) && interval > 0 && interval <= 60_000 ? interval : 5_000;
}

export async function pushTaskBranch(project: Project, workspacePath: string, branch: string): Promise<string> {
  return await withProjectGitLock(project, async () => {
    await execChecked(git(workspacePath, ["push", "--force-with-lease", "--set-upstream", project.remoteName, branch]));
    return await execChecked(git(workspacePath, ["rev-parse", "HEAD"]));
  });
}

export async function remoteTaskBranchHead(
  project: Project,
  workspacePath: string,
  branch: string,
): Promise<string | undefined> {
  const result = await execCommand(
    git(workspacePath, ["ls-remote", "--heads", project.remoteName, `refs/heads/${branch}`]),
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Unable to inspect remote branch ${branch}`);
  const sha = result.stdout.trim().split(/\s+/, 1)[0];
  return sha || undefined;
}

export async function deleteRemoteTaskBranch(project: Project, workspacePath: string, branch: string): Promise<void> {
  if (!await remoteTaskBranchHead(project, workspacePath, branch)) return;
  await withProjectGitLock(project, async () => {
    if (!await remoteTaskBranchHead(project, workspacePath, branch)) return;
    await execChecked(git(workspacePath, ["push", project.remoteName, "--delete", branch]));
  });
}

export async function findPullRequest(workspacePath: string, branch: string): Promise<PullRequest | undefined> {
  const output = await execChecked(
    gh(workspacePath, ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid"]),
  );
  const pullRequests = parseJson<PullRequest[]>(output || "[]", "gh pr list");
  return pullRequests.find((pullRequest) => pullRequest.state === "OPEN") ?? pullRequests[0];
}

export async function createOrGetPullRequest(
  project: Project,
  task: Task,
  workspacePath: string,
  branch: string,
): Promise<PullRequest> {
  const existing = await findPullRequest(workspacePath, branch);
  if (existing?.state === "OPEN") return existing;
  const body = [
    `AEC-S task: ${task.id}`,
    "",
    task.goal,
    "",
    `<!-- aec-s-task:${task.id} -->`,
  ].join("\n");
  await execChecked(
    gh(workspacePath, [
      "pr",
      "create",
      "--base",
      project.targetBranch,
      "--head",
      branch,
      "--title",
      task.title,
      "--body",
      body,
    ]),
  );
  const created = await findPullRequest(workspacePath, branch);
  if (!created) throw new Error(`GitHub PR was created but cannot be found for branch ${branch}`);
  return created;
}

export async function waitForRequiredChecks(
  project: Project,
  workspacePath: string,
  prNumber: number,
  timeoutSeconds = 1800,
  heartbeat?: () => void,
  pollIntervalMs = githubCheckPollIntervalMs(),
): Promise<void> {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 60_000) {
    throw new Error(`GitHub check poll interval must be between 1 and 60000 ms: ${String(pollIntervalMs)}`);
  }
  if (project.requiredChecks.length === 0) {
    throw new Error("GitHub delivery requires at least one explicitly configured required check");
  }
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    heartbeat?.();
    if (await inspectRequiredChecks(project, workspacePath, prNumber) === "passed") return;
    await sleepWithinDeadline(deadline, pollIntervalMs);
  }
  throw new Error(`Timed out waiting for GitHub checks on PR #${prNumber}`);
}

export async function inspectRequiredChecks(
  project: Project,
  workspacePath: string,
  prNumber: number,
): Promise<"pending" | "passed"> {
  if (project.requiredChecks.length === 0) {
    throw new Error("GitHub delivery requires at least one explicitly configured required check");
  }
  const result = await execCommand(
    gh(workspacePath, ["pr", "checks", String(prNumber), "--json", "name,state,bucket"], 120),
  );
  const diagnostic = result.stderr.trim();
  const noChecksYet = result.exitCode === 8 || (
    result.exitCode === 1 && /no checks reported|no checks found|checks? (?:have|has) not been reported/i.test(diagnostic)
  );
  const transientFailure = result.timedOut || (
    result.exitCode !== 0 && /HTTP\s+(?:408|429|5\d\d)|timed?\s*out|connection\s+reset|temporary|unexpected\s+EOF|network|failed\s+to\s+connect|TLS\s+handshake/i.test(diagnostic)
  );
  if (noChecksYet || transientFailure) return "pending";
  let checks: Array<{ name: string; state: string; bucket: string }> | undefined;
  if (result.stdout.trim()) {
    checks = parseJson<Array<{ name: string; state: string; bucket: string }>>(result.stdout, "gh pr checks");
  }
  // `gh pr checks` deliberately exits 1 when a check failed and still emits
  // the authoritative JSON on stdout. Parse that contract before treating a
  // non-zero exit as an operational inspection failure.
  if (!checks && result.exitCode !== 0) throw new Error(result.stderr.trim() || `Unable to inspect GitHub checks for PR #${prNumber}`);
  checks ??= [];
  const selected = checks.filter((check) => project.requiredChecks.includes(check.name));
  if (project.requiredChecks.some((name) => !checks.some((check) => check.name === name))) return "pending";
  if (selected.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
    const failedChecks = selected.filter((check) => check.bucket === "fail" || check.bucket === "cancel").map((check) => check.name);
    throw new AecError(
      AEC_ERROR.githubChecksFailed,
      `GitHub checks failed: ${failedChecks.join(", ")}`,
      { prNumber, failedChecks },
    );
  }
  return selected.every((check) => check.bucket === "pass") ? "passed" : "pending";
}

async function sleepWithinDeadline(deadline: number, intervalMs: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
}

export async function mergePullRequest(
  workspacePath: string,
  prNumber: number,
  expectedHeadSha: string,
): Promise<{ url: string; mergeSha: string }> {
  const existing = await reconcileMergedPullRequest(workspacePath, prNumber, expectedHeadSha);
  if (existing) return existing;
  await execChecked(
    gh(workspacePath, [
      "pr",
      "merge",
      String(prNumber),
      "--squash",
      "--delete-branch",
      "--match-head-commit",
      expectedHeadSha,
    ]),
  );
  const merged = await reconcileMergedPullRequest(workspacePath, prNumber, expectedHeadSha);
  if (!merged) throw new Error(`GitHub PR #${prNumber} is not merged`);
  return merged;
}

/**
 * Reconcile the durable GitHub fact before attempting any new side effect.
 *
 * `expectedHeadSha` is optional for recovery of older Runs whose Push effect
 * was overwritten as uncertain after GitHub had already deleted the branch.
 * The PR number itself still comes from AEC-S's completed pullRequest effect.
 */
export async function reconcileMergedPullRequest(
  workspacePath: string,
  prNumber: number,
  expectedHeadSha?: string,
): Promise<{ url: string; mergeSha: string } | undefined> {
  const pullRequest = await viewPullRequest(workspacePath, prNumber);
  if (pullRequest.state !== "MERGED") return undefined;
  if (expectedHeadSha && pullRequest.headRefOid !== expectedHeadSha) {
    throw new Error(`GitHub PR #${prNumber} was merged from unexpected head ${pullRequest.headRefOid ?? "unknown"}`);
  }
  const mergeSha = pullRequest.mergeCommit?.oid;
  if (!mergeSha) throw new Error(`GitHub PR #${prNumber} is merged without a merge commit`);
  return { url: pullRequest.url, mergeSha };
}

async function viewPullRequest(workspacePath: string, prNumber: number): Promise<PullRequest> {
  const output = await execChecked(
    gh(workspacePath, ["pr", "view", String(prNumber), "--json", "number,url,state,headRefOid,mergeCommit"]),
  );
  return parseJson<PullRequest>(output, "gh pr view");
}
