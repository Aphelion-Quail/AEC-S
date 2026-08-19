import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertGitRepository, branchHead, changedPaths, cleanupWorktree, createWorktree } from "../src/git.js";
import { createGitRepository, tempDir } from "./helpers.js";
import type { Project } from "../src/types.js";

test("parses tracked, untracked, renamed, and special Git paths without corruption", async () => {
  const repo = createGitRepository();
  const original = " leading\n名字.txt";
  writeFileSync(join(repo, original), "original\n");
  execFileSync("git", ["add", "--", original], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC-S Test", "-c", "user.email=aec-s-test@local", "commit", "-m", "special"], {
    cwd: repo,
    stdio: "ignore",
  });
  const base = await branchHead(repo, "HEAD");
  writeFileSync(join(repo, original), "modified\n");
  const renamed = "renamed \"文件\".txt";
  execFileSync("git", ["mv", "--", "README.md", renamed], { cwd: repo });
  const untracked = "new ünicode\nfile.txt";
  writeFileSync(join(repo, untracked), "new\n");

  assert.deepEqual(await changedPaths(repo, base), [original, "README.md", untracked, renamed].sort());
});

test("reuses an existing worktree with its actual historical base", async () => {
  const repo = createGitRepository();
  const project: Project = {
    id: "worktree-project",
    name: "worktree",
    repoPath: repo,
    targetBranch: "main",
    remoteName: "origin",
    deliveryMode: "local",
    intent: "",
    defaultValidation: [],
    fullValidation: [],
    requiredChecks: [],
    highRiskGlobs: [],
    maxConcurrency: 2,
    createdAt: new Date().toISOString(),
  };
  const workspace = join(tempDir("aec-s-existing-worktree-"), "workspace");
  const initial = await createWorktree(project, workspace, "aec-s/worktree-base");
  writeFileSync(join(repo, "later.txt"), "later\n");
  execFileSync("git", ["add", "later.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC-S Test", "-c", "user.email=aec-s-test@local", "commit", "-m", "later"], {
    cwd: repo,
    stdio: "ignore",
  });
  assert.notEqual(await branchHead(repo, "main"), initial);
  assert.equal(await createWorktree(project, workspace, "aec-s/worktree-base"), initial);
  await cleanupWorktree(project, workspace, "aec-s/worktree-base");
});

test("refuses repository-local Git hooks, filters, and external diff commands", async () => {
  const unsafeConfiguration: Array<[string, string]> = [
    ["filter.attack.clean", "touch /tmp/aec-s-filter-executed"],
    ["diff.attack.textconv", "touch /tmp/aec-s-diff-executed"],
    ["credential.helper", "!touch /tmp/aec-s-credential-helper-executed"],
    ["core.hooksPath", "/tmp/attacker-hooks"],
  ];
  for (const [key, value] of unsafeConfiguration) {
    const repo = createGitRepository();
    execFileSync("git", ["config", "--local", key, value], { cwd: repo });
    await assert.rejects(assertGitRepository(repo), /may execute external code/);
  }
});
