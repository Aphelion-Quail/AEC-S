import test from "node:test";
import assert from "node:assert/strict";
import { AecSDatabase } from "../src/db.js";
import { AecSEngine } from "../src/engine.js";
import { createGitRepository, fixturePath, tempDir } from "./helpers.js";

const fakeAgent = fixturePath("fake-agent.js");

test("creates a Human decision only after Agent repair options are exhausted", async () => {
  const db = new AecSDatabase(tempDir("aec-s-escalation-"));
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
  const engine = new AecSEngine(db);
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
  engine.applyDirective({ action: "pause", taskIds: [task!.id] });
  assert.equal(db.getTask(task!.id)?.status, "paused");
  assert.throws(
    () => engine.applyDirective({ action: "resume", taskIds: [task!.id] }),
    /unresolved Human Decision/,
  );
  engine.resolveDecision(decision!.id, { action: "cancel_task", reason: "Stop this fixture" });
  assert.equal(db.getTask(task!.id)?.status, "cancelled");
  assert.equal(db.getDecision(decision!.id)?.status, "resolved");
  assert.throws(() => engine.resolveDecision(decision!.id, { action: "cancel_task" }), /already resolved/);
  db.close();
});

test("creates an immediate typed Decision for a non-technical Worker blocker", async () => {
  const db = new AecSDatabase(tempDir("aec-s-architecture-escalation-"));
  const project = db.createProject({ name: "architecture", repoPath: createGitRepository() });
  db.createAgent({
    name: "architecture-worker",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "architecture-blocked", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-architecture",
    projectId: project.id,
    title: "Need architecture",
    goal: "Request a durable ownership decision",
    scope: { writeGlobs: ["architecture.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Decision exists"],
  }]);
  await engine.runTask(task!.id);
  const [decision] = db.listDecisions(project.id, "pending");
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(decision?.kind, "architecture");
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  assert.equal(run.workerResult?.blocker?.kind, "architecture");
  assert.ok(run.workerResultPath);
  db.close();
});

test("rejects undeclared Decision actions and cannot revive a terminal Task", () => {
  const db = new AecSDatabase(tempDir("aec-s-decision-authority-"));
  const project = db.createProject({ name: "decision-authority", repoPath: createGitRepository() });
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "decision-authority-task",
    projectId: project.id,
    title: "Bound decision authority",
    goal: "Only declared actions may change state",
    scope: { writeGlobs: ["authority.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Decision authority remains bounded"],
  }]);
  const recordOnly = db.createDecision({
    projectId: project.id,
    taskId: task!.id,
    kind: "record",
    title: "Record only",
    body: "This decision cannot resume work",
    options: ["record"],
  });
  assert.throws(() => engine.resolveDecision(recordOnly.id, { action: "resume_task" }), /does not permit action/);
  assert.equal(db.getDecision(recordOnly.id)?.status, "pending");
  const staleResume = db.createDecision({
    projectId: project.id,
    taskId: task!.id,
    kind: "direction",
    title: "Potentially stale resume",
    body: "Cancellation must remain terminal",
    options: ["resume_task"],
  });
  engine.applyDirective({ action: "cancel", taskIds: [task!.id] });
  assert.throws(() => engine.resolveDecision(staleResume.id, { action: "resume_task" }), /cannot change terminal Task/);
  assert.equal(db.getTask(task!.id)?.status, "cancelled");
  assert.equal(db.getDecision(staleResume.id)?.status, "pending");
  db.close();
});

test("resolves replace_task by creating an immutable replacement in the same Project", () => {
  const db = new AecSDatabase(tempDir("aec-s-replacement-"));
  const project = db.createProject({ name: "replacement", repoPath: createGitRepository() });
  const engine = new AecSEngine(db);
  const [oldTask] = engine.submitGraph(project.id, [{
    id: "task-old",
    projectId: project.id,
    title: "Old direction",
    goal: "Old goal",
    scope: { writeGlobs: ["old.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Old"],
  }]);
  db.updateTaskStatus(oldTask!.id, "awaiting_human");
  const decision = db.createDecision({
    projectId: project.id,
    taskId: oldTask!.id,
    kind: "tradeoff",
    title: "Replace direction",
    body: "Use a new immutable Task",
    options: ["replace_task"],
  });
  engine.resolveDecision(decision.id, {
    action: "replace_task",
    replacement: {
      id: "task-new",
      projectId: project.id,
      title: "New direction",
      goal: "New goal",
      scope: { writeGlobs: ["new.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["New"],
    },
  });
  assert.equal(db.getTask(oldTask!.id)?.status, "cancelled");
  assert.equal(db.getTask("task-new")?.replacesTaskId, oldTask!.id);
  assert.equal(db.getDecision(decision.id)?.status, "resolved");
  assert.throws(() => engine.submitGraph(project.id, [{
    id: "task-self",
    projectId: project.id,
    title: "Self",
    goal: "Invalid",
    scope: { writeGlobs: ["self.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Invalid"],
    replacesTaskId: "task-self",
  }]), /cannot replace itself/);
  const otherProject = db.createProject({ name: "other-project", repoPath: createGitRepository() });
  const [otherTask] = engine.submitGraph(otherProject.id, [{
    id: "task-other",
    projectId: otherProject.id,
    title: "Other Project",
    goal: "Remain isolated",
    scope: { writeGlobs: ["other.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Isolated"],
  }]);
  assert.throws(() => engine.submitGraph(project.id, [{
    id: "task-cross-project",
    projectId: project.id,
    title: "Invalid cross-project replacement",
    goal: "Must be rejected",
    scope: { writeGlobs: ["invalid.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Rejected"],
    replacesTaskId: otherTask!.id,
  }]), /another Project/);
  db.close();
});

test("retry_with_agent honors an eligible Human-selected alternate", async () => {
  const db = new AecSDatabase(tempDir("aec-s-retry-agent-"));
  const project = db.createProject({ name: "retry-agent", repoPath: createGitRepository() });
  db.createAgent({
    id: "agent-blocked",
    name: "blocked",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "blocked", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "blocked", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-retry-agent",
    projectId: project.id,
    title: "Retry alternate",
    goal: "Finish with another Agent",
    scope: { writeGlobs: ["retry.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["alternate succeeds"],
  }]);
  await engine.runTask(task!.id);
  const [decision] = db.listDecisions(project.id, "pending");
  assert.ok(decision);
  db.createAgent({
    id: "agent-working",
    name: "working",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } },
  });
  engine.resolveDecision(decision!.id, { action: "retry_with_agent", agentId: "agent-working" });
  assert.equal(db.getLatestRunForTask(task!.id)?.agentId, "agent-working");
  await engine.runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.ok(db.listEvents(project.id).some((event) =>
    event.type === "task.status_changed" && event.payload.from === "ready" && event.payload.to === "running"));
  db.close();
});
