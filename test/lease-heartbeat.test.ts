import test from "node:test";
import assert from "node:assert/strict";
import { AecSDatabase } from "../src/db.js";
import { AecSEngine } from "../src/engine.js";
import { AEC_ERROR, isAecError } from "../src/errors.js";
import type { Run } from "../src/types.js";
import { createGitRepository, tempDir } from "./helpers.js";

type EngineHeartbeat = {
  leaseOwner: string;
  withLeaseHeartbeat<T>(run: Run, operation: () => Promise<T>): Promise<T>;
};

function heartbeatFixture(): { db: AecSDatabase; engine: AecSEngine; run: Run } {
  const db = new AecSDatabase(tempDir("aec-s-heartbeat-"));
  const project = db.createProject({ name: "heartbeat", repoPath: createGitRepository() });
  const agent = db.createAgent({ id: "heartbeat-agent", name: "heartbeat", adapter: "command", roles: ["executor"] });
  const task = db.createTask({
    id: "heartbeat-task", projectId: project.id, title: "Heartbeat", goal: "Keep ownership",
    scope: { writeGlobs: ["heartbeat.txt"], watchGlobs: [], tags: [] }, acceptanceCriteria: ["Lease remains owned"],
  });
  const engine = new AecSEngine(db, { leaseHeartbeatMs: 5 });
  const owner = (engine as unknown as EngineHeartbeat).leaseOwner;
  const timestamp = new Date().toISOString();
  const run: Run = {
    id: "heartbeat-run", taskId: task.id, agentId: agent.id, workspaceId: "heartbeat-workspace",
    phase: "execute", status: "active", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base",
    validation: [], effects: {}, logDir: db.paths.home, startedAt: timestamp, updatedAt: timestamp,
    leaseOwner: owner, leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  db.createRun(run);
  return { db, engine, run };
}

test("a transient heartbeat exception cannot override a successful owned operation", async () => {
  const { db, engine, run } = heartbeatFixture();
  const original = db.renewRunLease.bind(db);
  let calls = 0;
  db.renewRunLease = (id, owner, leaseUntil) => {
    calls += 1;
    if (calls === 1) throw new Error("transient database contention");
    return original(id, owner, leaseUntil);
  };
  const value = await (engine as unknown as EngineHeartbeat).withLeaseHeartbeat(run, async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return "completed";
  });
  assert.equal(value, "completed");
  assert.ok(calls >= 2);
  db.close();
});

test("a confirmed lost lease remains fatal after the operation returns", async () => {
  const { db, engine, run } = heartbeatFixture();
  db.renewRunLease = () => false;
  await assert.rejects(
    (engine as unknown as EngineHeartbeat).withLeaseHeartbeat(run, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }),
    (error: unknown) => isAecError(error, AEC_ERROR.runLeaseLost),
  );
  db.close();
});

