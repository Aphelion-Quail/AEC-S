import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { AecDatabase } from "../src/db.js";
import { createGitRepository, tempDir } from "./helpers.js";
import type { Run } from "../src/types.js";

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
  assert.equal((db.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  assert.equal(db.updateProject(project.id, { intent: "Updated intent", maxConcurrency: 3 }).intent, "Updated intent");
  assert.equal(db.updateAgent(agent.id, { availability: "degraded", enabled: false }).enabled, false);
  db.updateTaskStatus(task.id, "succeeded", { summary: "done", mergeSha: "abc" });
  db.updateTaskStatus(task.id, "ready", { summary: null, mergeSha: null });
  assert.equal(db.getTask(task.id)?.terminalSummary, undefined);
  assert.equal(db.getTask(task.id)?.mergeSha, undefined);
  assert.ok(db.listEvents(project.id).length >= 3);
  db.close();
});

test("upgrades a pre-lease Run schema through recorded migrations", () => {
  const home = tempDir("aec-old-schema-");
  const legacy = new DatabaseSync(join(home, "aec.db"));
  legacy.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    repair_count INTEGER NOT NULL,
    rotation_count INTEGER NOT NULL,
    base_sha TEXT NOT NULL,
    codex_session_id TEXT,
    validation_json TEXT NOT NULL,
    review_json TEXT,
    effects_json TEXT NOT NULL,
    job_json TEXT,
    log_dir TEXT NOT NULL,
    diff_path TEXT,
    error_json TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lease_until TEXT
  )`);
  legacy.close();

  const db = new AecDatabase(home);
  const columns = (db.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns.includes("lease_owner"));
  assert.ok(columns.includes("worker_result_json"));
  assert.ok(columns.includes("worker_result_path"));
  assert.deepEqual(
    (db.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version),
    [1, 2, 3, 4],
  );
  assert.equal((db.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  db.close();
});

test("fences stale Run writes and atomically resumes an interrupted Run", () => {
  const home = tempDir("aec-run-fence-");
  const db = new AecDatabase(home);
  const project = db.createProject({ name: "fence", repoPath: createGitRepository() });
  const agent = db.createAgent({ name: "executor", adapter: "command", roles: ["executor"] });
  const task = db.createTask({
    projectId: project.id,
    title: "Fence Run",
    goal: "Only one owner writes",
    scope: { writeGlobs: ["fenced.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["single owner"],
  });
  const timestamp = new Date().toISOString();
  const run: Run = {
    id: "run-fence",
    taskId: task.id,
    agentId: agent.id,
    workspaceId: "workspace-fence",
    phase: "prepare",
    status: "active",
    attempt: 1,
    repairCount: 0,
    rotationCount: 0,
    baseSha: "base",
    validation: [],
    effects: {},
    logDir: home,
    startedAt: timestamp,
    updatedAt: timestamp,
    leaseOwner: "owner-a",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  db.createRun(run);
  const stale = db.getRun(run.id)!;
  assert.equal(db.claimRun(run.id, "owner-a", "owner-b", new Date(Date.now() + 60_000).toISOString()), true);
  stale.phase = "merge";
  assert.equal(db.saveRun(stale, "owner-a"), false);
  assert.equal(db.getRun(run.id)?.phase, "prepare");
  assert.equal(db.getRun(run.id)?.leaseOwner, "owner-b");

  db.db.prepare("UPDATE runs SET status='interrupted', lease_owner=NULL, lease_until=NULL WHERE id=?").run(run.id);
  const competitor = new AecDatabase(home);
  assert.equal(db.resumeInterruptedRun(run.id, "winner", new Date(Date.now() + 60_000).toISOString()), true);
  assert.equal(competitor.resumeInterruptedRun(run.id, "loser", new Date(Date.now() + 60_000).toISOString()), false);
  assert.equal(competitor.getRun(run.id)?.leaseOwner, "winner");
  const secondTask = db.createTask({
    projectId: project.id,
    title: "Second Run",
    goal: "Compete for Agent capacity",
    scope: { writeGlobs: ["second.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["capacity is atomic"],
  });
  db.createRun({ ...run, id: "run-second", taskId: secondTask.id, workspaceId: "workspace-second", leaseOwner: undefined });
  assert.equal(db.reserveAgentSlot(agent.id, run.id, "job-winner"), true);
  assert.equal(competitor.reserveAgentSlot(agent.id, "run-second", "job-loser"), false);
  db.releaseAgentSlot("job-winner");
  assert.equal(competitor.reserveAgentSlot(agent.id, "run-second", "job-loser"), true);
  competitor.releaseAgentSlot("job-loser");
  competitor.close();
  db.close();
});

test("rejects a database created by a newer AEC schema", () => {
  const home = tempDir("aec-new-schema-");
  const future = new DatabaseSync(join(home, "aec.db"));
  future.exec("PRAGMA user_version=999");
  future.close();
  assert.throws(() => new AecDatabase(home), /newer than supported/);
});
