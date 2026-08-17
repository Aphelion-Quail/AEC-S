import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createGitRepository, fixturePath, tempDir } from "./helpers.js";
import { projectLockDatabasePath, withProjectGitLock } from "../src/git.js";
import type { Project } from "../src/types.js";

const worker = fixturePath("git-lock-worker.js");

function runWorker(repo: string, output: string, id: string): Promise<void> {
  const child = spawn(process.execPath, [worker, repo, output, id], { stdio: "ignore" });
  return new Promise((resolvePromise, reject) => {
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`lock worker ${id} exited ${code}`)));
  });
}

test("serializes Project Git sections across AEC-S processes", async () => {
  const repo = createGitRepository();
  const output = join(tempDir("aec-s-git-lock-"), "timeline.log");
  await Promise.all([runWorker(repo, output, "a"), runWorker(repo, output, "b")]);
  const events = readFileSync(output, "utf8").trim().split(/\r?\n/).map((line) => line.split(":"));
  assert.equal(events.length, 4);
  assert.equal(events[0]![1], "start");
  assert.equal(events[1]![1], "end");
  assert.equal(events[2]![1], "start");
  assert.equal(events[3]![1], "end");
  assert.notEqual(events[0]![0], events[2]![0]);
  const project = { ...projectFor(repo), id: "lock-location" };
  const databasePath = await projectLockDatabasePath(project);
  assert.equal(databasePath.startsWith(repo), false, "coordination locks must not live in the target repository");
  assert.equal(existsSync(join(repo, ".git", "aec-s-project-git-lock.sqlite")), false);
});

function projectFor(repo: string): Project {
  return {
    id: "project-lock",
    name: "lock",
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
}

test("releases the in-process queue when file-lock acquisition fails", async () => {
  const repo = createGitRepository();
  const base: Project = { ...projectFor(repo), id: "acquire-failure" };
  await assert.rejects(withProjectGitLock({ ...base, repoPath: join(repo, "missing") }, async () => undefined));
  const result = await Promise.race([
    withProjectGitLock(base, async () => "acquired"),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("second lock attempt deadlocked")), 2_000)),
  ]);
  assert.equal(result, "acquired");
});
