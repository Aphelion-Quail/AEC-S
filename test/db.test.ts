import test from "node:test";
import assert from "node:assert/strict";
import { AecDatabase } from "../src/db.js";
import { createGitRepository, tempDir } from "./helpers.js";

test("persists the seven core entity projections", () => {
  const home = tempDir("aec-home-");
  const db = new AecDatabase(home);
  const project = db.createProject({ name: "fixture", repoPath: createGitRepository() });
  const agent = db.createAgent({ name: "fake", adapter: "command", roles: ["executor"], config: { binary: process.execPath } });
  const task = db.createTask({
    projectId: project.id,
    title: "Add a file",
    goal: "Create feature.txt",
    scope: { writeGlobs: ["feature.txt"], impactGlobs: [], tags: ["core"] },
    acceptanceCriteria: ["feature.txt exists"],
  });
  const decision = db.createDecision({
    projectId: project.id,
    taskId: task.id,
    kind: "record",
    status: "resolved",
    title: "Keep compatibility",
    body: "Do not break existing input",
  });
  assert.equal(db.getProject(project.id)?.name, "fixture");
  assert.equal(db.getAgent(agent.id)?.name, "fake");
  assert.equal(db.getTask(task.id)?.goal, "Create feature.txt");
  assert.equal(db.getDecision(decision.id)?.status, "resolved");
  assert.ok(db.listEvents(project.id).length >= 3);
  db.close();
});
