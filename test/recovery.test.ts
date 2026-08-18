import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AecSDatabase } from "../src/db.js";
import { AecSEngine } from "../src/engine.js";
import { branchHead, commitTask, createWorktree, localMerge } from "../src/git.js";
import type { Run, Workspace } from "../src/types.js";
import { builtCliPath, createGitRepository, fixturePath, tempDir } from "./helpers.js";

const cli = builtCliPath();
const fakeAgent = fixturePath("fake-agent.js");

async function prepareExternallyMergedRun(status: Run["status"], phase: Run["phase"], markTaskSucceeded = true) {
  const repo = createGitRepository();
  const home = tempDir("aec-s-merge-recovery-");
  const db = new AecSDatabase(home);
  const project = db.createProject({ name: `merge-${phase}`, repoPath: repo });
  const agent = db.createAgent({ name: "executor", adapter: "command", roles: ["executor"], config: { binary: process.execPath } });
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: `task-${phase}`,
    projectId: project.id,
    title: `Recover ${phase}`,
    goal: "Recover merged Git fact",
    scope: { writeGlobs: ["merged.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["merged.txt is merged"],
  }]);
  engine.promoteTasks();
  const baseSha = await branchHead(repo, "main");
  const timestamp = new Date().toISOString();
  const runId = `run-${phase}`;
  const workspaceId = `workspace-${phase}`;
  const workspacePath = join(home, "workspaces", project.id, task!.id, runId);
  const logDir = join(home, "runs", runId);
  mkdirSync(logDir, { recursive: true });
  const run: Run = {
    id: runId,
    taskId: task!.id,
    agentId: agent.id,
    workspaceId,
    phase,
    status,
    attempt: 1,
    repairCount: 0,
    rotationCount: 0,
    baseSha,
    validation: [],
    effects: {},
    logDir,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  const workspace: Workspace = {
    id: workspaceId,
    projectId: project.id,
    taskId: task!.id,
    runId,
    path: workspacePath,
    branch: `aec-s/${task!.id}`,
    baseSha,
    status: "creating",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.createRun(run);
  db.createWorkspace(workspace);
  db.updateTaskStatus(task!.id, "running");
  await createWorktree(project, workspace.path, workspace.branch);
  db.updateWorkspaceStatus(workspace.id, "active");
  writeFileSync(join(workspace.path, "merged.txt"), "merged once\n");
  const commitSha = await commitTask(workspace.path, task!);
  await localMerge(project, workspace.branch, commitSha);
  run.effects = {
    commit: { operationId: `${project.id}:${task!.id}:${run.id}:commit`, status: "completed", externalRef: commitSha },
    merge: { operationId: `${project.id}:${task!.id}:${run.id}:merge`, status: phase === "cleanup" ? "completed" : "started", ...(phase === "cleanup" ? { externalRef: commitSha } : {}) },
  };
  if (phase === "cleanup" && markTaskSucceeded) db.updateTaskStatus(task!.id, "succeeded", { mergeSha: commitSha });
  db.saveRun(run);
  return { db, engine: new AecSEngine(db), project, task: task!, run, workspace, repo, commitSha };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Condition was not met before timeout");
}

test("resumes a supervised Agent job after the controlling process is killed", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-s-recovery-");
  let db = new AecSDatabase(home);
  const project = db.createProject({ name: "recovery", repoPath: repo });
  db.createAgent({
    name: "slow-worker",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "slow", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "slow", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [
    {
      id: "task-recovery",
      projectId: project.id,
      title: "Recover task",
      goal: "Create recovered.txt",
      scope: { writeGlobs: ["recovered.txt"], impactGlobs: [], tags: ["recovery"] },
      acceptanceCriteria: ["recovered.txt exists"],
    },
  ]);
  db.close();

  const controller = spawn(process.execPath, [cli, "run", task!.id], {
    env: { ...process.env, AEC_S_HOME: home },
    stdio: "ignore",
  });
  await waitUntil(() => {
    const inspect = new AecSDatabase(home);
    const active = inspect.getLatestRunForTask(task!.id);
    inspect.close();
    return Boolean(active?.job);
  });
  controller.kill("SIGKILL");
  await new Promise((resolvePromise) => controller.once("close", resolvePromise));

  db = new AecSDatabase(home);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(existsSync(join(repo, "recovered.txt")), true);
  assert.equal(db.listRuns(task!.id).length, 1);
  db.close();
});

test("two AEC-S processes cannot execute the same Run concurrently", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-s-lease-");
  const db = new AecSDatabase(home);
  const project = db.createProject({ name: "lease", repoPath: repo });
  db.createAgent({
    name: "slow-worker",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "slow", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-single-owner",
    projectId: project.id,
    title: "One owner",
    goal: "Create owned.txt once",
    scope: { writeGlobs: ["owned.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["owned.txt exists"],
  }]);
  assert.ok(task);
  db.close();

  const first = spawn(process.execPath, [cli, "run", task.id], { env: { ...process.env, AEC_S_HOME: home }, stdio: "ignore" });
  const second = spawn(process.execPath, [cli, "run", task.id], { env: { ...process.env, AEC_S_HOME: home }, stdio: "ignore" });
  await Promise.all([
    new Promise<void>((resolvePromise, reject) => first.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`first exited ${code}`)))),
    new Promise<void>((resolvePromise, reject) => second.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`second exited ${code}`)))),
  ]);

  const inspect = new AecSDatabase(home);
  assert.equal(inspect.listRuns(task.id).length, 1);
  assert.equal(inspect.getTask(task.id)?.status, "succeeded");
  inspect.close();
});

test("reconciles a local merge completed before its effect was persisted", async () => {
  const fixture = await prepareExternallyMergedRun("active", "merge");
  await fixture.engine.runTask(fixture.task.id);
  assert.equal(
    fixture.db.getTask(fixture.task.id)?.status,
    "succeeded",
    JSON.stringify(fixture.db.getLatestRunForTask(fixture.task.id)?.error),
  );
  assert.equal(fixture.db.getLatestRunForTask(fixture.task.id)?.effects.merge?.externalRef, fixture.commitSha);
  assert.equal(fixture.db.getLatestRunForTask(fixture.task.id)?.status, "completed");
  fixture.db.close();
});

test("retries interrupted cleanup without downgrading a succeeded Task", async () => {
  const fixture = await prepareExternallyMergedRun("interrupted", "cleanup");
  await fixture.engine.runOnce();
  assert.equal(fixture.db.getTask(fixture.task.id)?.status, "succeeded");
  assert.equal(fixture.db.getLatestRunForTask(fixture.task.id)?.status, "completed");
  assert.equal(fixture.db.getWorkspace(fixture.workspace.id)?.status, "cleaned");
  fixture.db.close();
});

test("repairs the Task terminal state when merge completion was persisted first", async () => {
  const fixture = await prepareExternallyMergedRun("interrupted", "cleanup", false);
  await fixture.engine.runTask(fixture.task.id);
  assert.equal(fixture.db.getTask(fixture.task.id)?.status, "succeeded");
  assert.equal(fixture.db.getTask(fixture.task.id)?.mergeSha, fixture.commitSha);
  assert.equal(fixture.db.getLatestRunForTask(fixture.task.id)?.status, "completed");
  fixture.db.close();
});
