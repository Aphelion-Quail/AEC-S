import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { AecDatabase } from "../src/db.js";
import { AecEngine } from "../src/engine.js";
import { createGitRepository, tempDir } from "./helpers.js";

const fakeAgent = resolve("dist/test/fixtures/fake-agent.js");

test("runs two independent tasks without invalidating the second on HEAD change", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-home-");
  const db = new AecDatabase(home);
  const project = db.createProject({
    name: "parallel-fixture",
    repoPath: repo,
    defaultValidation: [{ program: process.execPath, args: ["-e", "process.exit(0)"] }],
    fullValidation: [{ program: process.execPath, args: ["-e", "require('node:fs').writeFileSync('FULL_RAN','yes')"] }],
    highRiskGlobs: ["shared/**"],
    maxConcurrency: 2,
  });
  db.createAgent({
    id: "executor",
    name: "fake-worker",
    adapter: "command",
    roles: ["executor"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "fake-reviewer",
    adapter: "command",
    roles: ["reviewer"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecEngine(db, { globalConcurrency: 2 });
  const tasks = engine.submitGraph(project.id, [
    {
      id: "task-ui",
      projectId: project.id,
      title: "Add UI",
      goal: "Create ui/result.txt",
      scope: { writeGlobs: ["ui/result.txt"], impactGlobs: [], tags: ["ui"] },
      acceptanceCriteria: ["UI file exists"],
      validationCommands: [{ program: process.execPath, args: ["-e", "require('node:fs').accessSync('ui/result.txt')"] }],
    },
    {
      id: "task-core",
      projectId: project.id,
      title: "Add Core",
      goal: "Create core/result.txt",
      scope: { writeGlobs: ["core/result.txt"], impactGlobs: [], tags: ["core"] },
      acceptanceCriteria: ["Core file exists"],
      validationCommands: [{ program: process.execPath, args: ["-e", "require('node:fs').accessSync('core/result.txt')"] }],
    },
  ]);
  await engine.runUntilIdle();
  for (const task of tasks) assert.equal(db.getTask(task.id)?.status, "succeeded");
  assert.equal(existsSync(join(repo, "ui/result.txt")), true);
  assert.equal(existsSync(join(repo, "core/result.txt")), true);
  assert.equal(existsSync(join(repo, "FULL_RAN")), false);
  const log = execFileSync("git", ["log", "--format=%B"], { cwd: repo, encoding: "utf8" });
  assert.match(log, /AEC-Task: task-ui/);
  assert.match(log, /AEC-Task: task-core/);
  const runs = db.listRuns();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.validation.every((validation) => validation.status === "passed")));
  assert.ok(runs.every((run) => run.review?.verdict === "pass"));
  assert.ok(runs.every((run) => run.review?.reviewerAgentId !== run.agentId));
  assert.ok(runs.every((run) => readFileSync(run.diffPath!, "utf8").length > 0));
  await engine.runTask(tasks[0]!.id);
  assert.equal(db.listRuns().length, 2, "rerunning a succeeded task must not create another Run");
  db.close();
});

test("a paused active run does not occupy a scheduler slot", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-home-"));
  const project = db.createProject({ name: "pause-fixture", repoPath: repo });
  db.createAgent({
    name: "fake-worker",
    adapter: "command",
    roles: ["executor", "reviewer"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-paused",
    projectId: project.id,
    title: "Paused task",
    goal: "Create paused/result.txt",
    scope: { writeGlobs: ["paused/result.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["File exists"],
  }]);
  assert.ok(task);
  engine.applyDirective({ action: "pause", taskIds: [task.id] });
  assert.equal(await engine.runOnce(), 0);
  assert.equal(db.listRuns().length, 0);
  engine.applyDirective({ action: "resume", taskIds: [task.id] });
  await engine.runUntilIdle();
  assert.equal(db.getTask(task.id)?.status, "succeeded");
  db.close();
});
