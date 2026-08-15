import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AecDatabase } from "../src/db.js";
import { AecEngine } from "../src/engine.js";
import { createGitRepository, tempDir } from "./helpers.js";

const cli = resolve("dist/src/cli.js");
const fakeAgent = resolve("dist/test/fixtures/fake-agent.js");

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
  const home = tempDir("aec-recovery-");
  let db = new AecDatabase(home);
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
  const engine = new AecEngine(db);
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
    env: { ...process.env, AEC_HOME: home },
    stdio: "ignore",
  });
  await waitUntil(() => {
    const inspect = new AecDatabase(home);
    const active = inspect.getLatestRunForTask(task!.id);
    inspect.close();
    return Boolean(active?.job);
  });
  controller.kill("SIGKILL");
  await new Promise((resolvePromise) => controller.once("close", resolvePromise));

  db = new AecDatabase(home);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(existsSync(join(repo, "recovered.txt")), true);
  assert.equal(db.listRuns(task!.id).length, 1);
  db.close();
});

test("two AEC processes cannot execute the same Run concurrently", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-lease-");
  const db = new AecDatabase(home);
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
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-single-owner",
    projectId: project.id,
    title: "One owner",
    goal: "Create owned.txt once",
    scope: { writeGlobs: ["owned.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["owned.txt exists"],
  }]);
  assert.ok(task);
  db.close();

  const first = spawn(process.execPath, [cli, "run", task.id], { env: { ...process.env, AEC_HOME: home }, stdio: "ignore" });
  const second = spawn(process.execPath, [cli, "run", task.id], { env: { ...process.env, AEC_HOME: home }, stdio: "ignore" });
  await Promise.all([
    new Promise<void>((resolvePromise, reject) => first.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`first exited ${code}`)))),
    new Promise<void>((resolvePromise, reject) => second.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`second exited ${code}`)))),
  ]);

  const inspect = new AecDatabase(home);
  assert.equal(inspect.listRuns(task.id).length, 1);
  assert.equal(inspect.getTask(task.id)?.status, "succeeded");
  inspect.close();
});
