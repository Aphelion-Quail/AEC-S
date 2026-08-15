import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AecDatabase } from "../src/db.js";
import { AecEngine } from "../src/engine.js";
import { createGitRepository, tempDir } from "./helpers.js";

const fakeAgent = resolve("dist/test/fixtures/fake-agent.js");

test("creates a Human decision only after Agent repair options are exhausted", async () => {
  const db = new AecDatabase(tempDir("aec-escalation-"));
  const project = db.createProject({ name: "escalation", repoPath: createGitRepository() });
  db.createAgent({
    name: "blocked-worker",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "blocked", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "blocked", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecEngine(db);
  const [task] = engine.submitGraph(project.id, [
    {
      id: "task-blocked",
      projectId: project.id,
      title: "Blocked task",
      goal: "Demonstrate escalation",
      scope: { writeGlobs: ["blocked.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["A result exists"],
    },
  ]);
  await engine.runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  const [decision] = db.listDecisions(project.id, "pending");
  assert.equal(decision?.kind, "failure_exhausted");
  engine.resolveDecision(decision!.id, { action: "cancel_task", reason: "Stop this fixture" });
  assert.equal(db.getTask(task!.id)?.status, "cancelled");
  assert.equal(db.getDecision(decision!.id)?.status, "resolved");
  db.close();
});
