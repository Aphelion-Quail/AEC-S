import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchHead, changedPaths, cleanupWorktree, createWorktree } from "../src/git.js";
import { createGitRepository, tempDir } from "./helpers.js";
import type { Project } from "../src/types.js";

test("parses tracked, untracked, renamed, and special Git paths without corruption", async () => {
  const repo = createGitRepository();
  const original = " leading\n名字.txt";
  writeFileSync(join(repo, original), "original\n");
  execFileSync("git", ["add", "--", original], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC Test", "-c", "user.email=aec-test@local", "commit", "-m", "special"], {
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
  const workspace = join(tempDir("aec-existing-worktree-"), "workspace");
  const initial = await createWorktree(project, workspace, "aec/worktree-base");
  writeFileSync(join(repo, "later.txt"), "later\n");
  execFileSync("git", ["add", "later.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC Test", "-c", "user.email=aec-test@local", "commit", "-m", "later"], {
    cwd: repo,
    stdio: "ignore",
  });
  assert.notEqual(await branchHead(repo, "main"), initial);
  assert.equal(await createWorktree(project, workspace, "aec/worktree-base"), initial);
  await cleanupWorktree(project, workspace, "aec/worktree-base");
});
