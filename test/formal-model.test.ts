import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { AecSDatabase } from "../src/db.js";
import { AecSEngine } from "../src/engine.js";
import { initializeAecS, inspectProject } from "../src/onboarding.js";
import type { Run } from "../src/types.js";
import { createGitRepository, tempDir } from "./helpers.js";

test("versions Project facts and rebinds nonterminal Tasks through a calibration Revision", () => {
  const db = new AecSDatabase(tempDir("aec-s-formal-project-"));
  const project = db.createProject({ name: "formal", repoPath: createGitRepository(), intent: "v1" });
  const task = db.createTask({
    projectId: project.id,
    title: "Versioned facts",
    goal: "Remain bound to authoritative Project facts",
    scope: { writeGlobs: ["src/value.ts"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Context is current"],
  });
  assert.throws(() => db.updateProject(project.id, { intent: "v2" }), /intentVersion/);
  const before = task.currentRevisionId;
  db.updateProject(project.id, { intent: "v2", intentVersion: 2 });
  const after = db.getTask(task.id)!;
  assert.notEqual(after.currentRevisionId, before);
  assert.equal(db.getTaskRevision(after.currentRevisionId!)?.reason, "calibration");
  assert.equal(db.listTaskRevisions(task.id).length, 2);
  db.close();
});

test("creates a new Scope Revision and raises the deterministic Risk Floor", () => {
  const db = new AecSDatabase(tempDir("aec-s-formal-scope-"));
  const project = db.createProject({ name: "scope", repoPath: createGitRepository(), highRiskGlobs: ["src/core/**"] });
  const task = db.createTask({
    projectId: project.id,
    title: "Docs first",
    goal: "Expand only through evidence",
    scope: { writeGlobs: ["docs/guide.md"], watchGlobs: [], tags: [] },
    proposedRiskClass: "docs",
    acceptanceCriteria: ["Revision is explicit"],
  });
  const revision = db.createScopeExpansionRevision(task.id, {
    addWriteGlobs: ["src/core/state.ts"],
    addWatchGlobs: ["src/core/**"],
    evidence: "The documented API and implementation must change atomically",
  });
  assert.equal(revision.revision, 2);
  assert.equal(revision.effectiveRiskClass, "core");
  assert.equal(revision.gateProfile.review, "strict");
  assert.throws(() => db.createScopeExpansionRevision(task.id, {
    addWriteGlobs: [], addWatchGlobs: [], evidence: "no change",
  }), /must add/);
  assert.throws(() => db.createScopeExpansionRevision(task.id, {
    addWriteGlobs: ["../outside"], addWatchGlobs: [], evidence: "invalid traversal",
  }), /repository-relative glob/);
  db.close();
});

test("persists Finding authority and prevents an implementer from terminating its own Finding", () => {
  const home = tempDir("aec-s-formal-finding-");
  const db = new AecSDatabase(home);
  const project = db.createProject({ name: "finding", repoPath: createGitRepository() });
  const executor = db.createAgent({ id: "executor", name: "executor", adapter: "command", roles: ["executor"] });
  const reviewer = db.createAgent({ id: "reviewer", name: "reviewer", adapter: "command", roles: ["reviewer"] });
  const task = db.createTask({
    projectId: project.id,
    title: "Finding evidence",
    goal: "Keep Review observational",
    scope: { writeGlobs: ["finding.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Evidence controls transitions"],
  });
  const now = new Date().toISOString();
  const run: Run = {
    id: "finding-run", taskId: task.id, agentId: executor.id, workspaceId: "finding-workspace",
    phase: "review", status: "active", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base",
    taskRevisionId: task.currentRevisionId, validation: [], effects: {}, logDir: home, startedAt: now, updatedAt: now,
  };
  db.createRun(run);
  const finding = db.createFinding({
    projectId: project.id, taskId: task.id, runId: run.id, taskRevisionId: task.currentRevisionId!,
    severity: "blocking", summary: "Reproducible defect", rule: "FORMAL-1", reviewerAgentId: reviewer.id,
  });
  db.transitionFinding(finding.id, "verified", "Independent deterministic reproduction", reviewer.id);
  assert.equal(db.hasVerifiedBlockingFindings(task.id, task.currentRevisionId), true);
  const nextRevision = db.createScopeExpansionRevision(task.id, {
    addWriteGlobs: ["finding-repair.txt"], addWatchGlobs: [], evidence: "Repair requires a new bounded file",
  });
  assert.equal(db.hasVerifiedBlockingFindings(task.id, nextRevision.id), false);
  assert.equal(db.hasVerifiedBlockingFindings(task.id), true);
  assert.throws(() => db.transitionFinding(finding.id, "resolved", "self claim", executor.id), /Implementer/);
  assert.equal(db.transitionFinding(finding.id, "resolved", "Independent rerun passed", reviewer.id).status, "resolved");
  const decision = db.createDecision({
    projectId: project.id,
    taskId: task.id,
    kind: "direction",
    title: "Resume safely",
    body: "Apply a bounded resolution",
  });
  const fakeApiKey = `sk-${"test".repeat(5)}`;
  new AecSEngine(db).resolveDecision(decision.id, { action: "resume_task", apiKey: fakeApiKey });
  const persistedRun = db.db.prepare("SELECT error_json FROM runs WHERE id=?").get(run.id) as { error_json: string };
  assert.equal(persistedRun.error_json.includes(fakeApiKey), false);
  db.close();
});

test("keeps Human-on-Exception delivery durable and rejects persisted credentials", () => {
  const db = new AecSDatabase(tempDir("aec-s-formal-outbox-"));
  const project = db.createProject({ name: "outbox", repoPath: createGitRepository() });
  const fakeApiKey = `sk-${"test".repeat(5)}`;
  const fakeBearer = `Bearer ${"test".repeat(6)}`;
  assert.throws(() => db.createAgent({
    name: "unsafe", adapter: "kimi", roles: ["executor"], config: { apiKey: fakeApiKey },
  }), /cannot be persisted/);
  assert.throws(() => db.createAgent({
    name: "unsafe-camel-case", adapter: "kimi", roles: ["executor"], config: { clientSecret: "opaque" },
  }), /cannot be persisted/);
  const decision = db.createDecision({
    projectId: project.id, kind: "direction", title: "Direction needed", body: "No legal path remains",
  });
  assert.equal(db.listOutbox(project.id).length, 2);
  db.resolveDecision(decision.id, {
    action: "record",
    apiKey: fakeApiKey,
    note: fakeBearer,
  });
  const stored = db.getDecision(decision.id)!;
  assert.equal(stored.resolution?.apiKey, "[REDACTED]");
  assert.equal(stored.resolution?.note, "[REDACTED]");
  const status = JSON.stringify(db.statusSnapshot());
  assert.equal(status.includes(fakeApiKey), false);
  assert.equal(status.includes(fakeBearer), false);
  assert.ok(db.listOutbox(project.id).every((message) => message.status === "acknowledged"));
  db.close();
});

test("honors configured Runtime health thresholds without hidden hard caps", () => {
  const db = new AecSDatabase(tempDir("aec-s-formal-health-threshold-"));
  db.createProject({
    name: "health policy",
    repoPath: createGitRepository(),
    operationalConfig: { healthFailureThreshold: 5, healthRecoveryThreshold: 4 },
  });
  const agent = db.createAgent({ name: "health target", adapter: "command", roles: ["executor"] });
  for (let sample = 0; sample < 4; sample += 1) db.recordAgentHealth(agent.id, false);
  assert.equal(db.getAgent(agent.id)?.availability, "degraded");
  db.recordAgentHealth(agent.id, false);
  assert.equal(db.getAgent(agent.id)?.availability, "unavailable");
  db.close();
});

test("rejects automatic opening of pre-1.0 state and imports repository facts as a proposal", async () => {
  const home = tempDir("aec-s-formal-legacy-");
  const legacy = new DatabaseSync(join(home, "aec-s.db"));
  legacy.exec("PRAGMA user_version=4");
  legacy.close();
  assert.throws(() => new AecSDatabase(home), /atomically archived.*aec-s init/);

  const repo = createGitRepository();
  const inspected = await inspectProject(repo);
  assert.equal(inspected.project.repoPath, repo);
  assert.equal(inspected.project.intent, "[Human confirmation required]");
  assert.ok(Array.isArray(inspected.detected.requiredHumanConfirmation));
});

test("initializes all first-class Runtime registrations without requiring manual paths", async () => {
  const previous = process.env.AEC_S_HOME;
  const home = tempDir("aec-s-onboarding-");
  process.env.AEC_S_HOME = home;
  try {
    const initialized = await initializeAecS({ installService: false });
    assert.equal(initialized.home, home);
    assert.equal(initialized.service, "skipped");
    const runtimes = initialized.runtimes as Array<{ family: string; probe?: { checks?: unknown } }>;
    assert.deepEqual([...new Set(runtimes.map((runtime) => runtime.family))].sort(), ["codex", "deepseek_harness", "kimi"]);
    assert.ok(runtimes.every((runtime) => runtime.probe && typeof runtime.probe === "object"));
  } finally {
    if (previous === undefined) delete process.env.AEC_S_HOME;
    else process.env.AEC_S_HOME = previous;
  }
});
