import type { Project, Task } from "./types.js";
import { execChecked, execCommand } from "./exec.js";

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

export async function pushTaskBranch(project: Project, workspacePath: string, branch: string): Promise<string> {
  await execChecked(git(workspacePath, ["push", "--force-with-lease", "--set-upstream", project.remoteName, branch]));
  return await execChecked(git(workspacePath, ["rev-parse", "HEAD"]));
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

export async function findPullRequest(workspacePath: string, branch: string): Promise<PullRequest | undefined> {
  const output = await execChecked(
    gh(workspacePath, ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid"]),
  );
  return parseJson<PullRequest[]>(output || "[]", "gh pr list")[0];
}

export async function createOrGetPullRequest(
  project: Project,
  task: Task,
  workspacePath: string,
  branch: string,
): Promise<PullRequest> {
  const existing = await findPullRequest(workspacePath, branch);
  if (existing && existing.state !== "CLOSED") return existing;
  const body = [
    `AEC task: ${task.id}`,
    "",
    task.goal,
    "",
    `<!-- aec-task:${task.id} -->`,
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
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const result = await execCommand(
      gh(workspacePath, ["pr", "checks", String(prNumber), "--json", "name,state,bucket"], 120),
    );
    const checks = parseJson<Array<{ name: string; state: string; bucket: string }>>(result.stdout || "[]", "gh pr checks");
    const selected = project.requiredChecks.length > 0
      ? checks.filter((check) => project.requiredChecks.includes(check.name))
      : checks;
    if (project.requiredChecks.some((name) => !checks.some((check) => check.name === name))) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    if (selected.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
      throw new Error(`GitHub checks failed: ${selected.filter((check) => check.bucket === "fail" || check.bucket === "cancel").map((check) => check.name).join(", ")}`);
    }
    if (selected.every((check) => check.bucket === "pass" || check.bucket === "skipping")) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for GitHub checks on PR #${prNumber}`);
}

export async function mergePullRequest(
  workspacePath: string,
  prNumber: number,
  expectedHeadSha: string,
): Promise<{ url: string; mergeSha: string }> {
  const before = await viewPullRequest(workspacePath, prNumber);
  if (before.state !== "MERGED") {
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
  }
  const after = await viewPullRequest(workspacePath, prNumber);
  const mergeSha = after.mergeCommit?.oid;
  if (after.state !== "MERGED" || !mergeSha) throw new Error(`GitHub PR #${prNumber} is not merged`);
  return { url: after.url, mergeSha };
}

async function viewPullRequest(workspacePath: string, prNumber: number): Promise<PullRequest> {
  const output = await execChecked(
    gh(workspacePath, ["pr", "view", String(prNumber), "--json", "number,url,state,headRefOid,mergeCommit"]),
  );
  return parseJson<PullRequest>(output, "gh pr view");
}

export async function githubHealthcheck(repoPath: string): Promise<{ ok: boolean; detail: string }> {
  const result = await execCommand(gh(repoPath, ["auth", "status"], 30));
  return { ok: result.exitCode === 0, detail: result.stdout.trim() || result.stderr.trim() };
}
