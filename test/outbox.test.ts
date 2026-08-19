import test from "node:test";
import assert from "node:assert/strict";
import { AecSDatabase } from "../src/db.js";
import { deliverSystemOutboxOnce, systemOutboxLoop } from "../src/outbox.js";
import { createGitRepository, tempDir } from "./helpers.js";

test("delivers only successful system Outbox messages and leaves failures retryable", async () => {
  const db = new AecSDatabase(tempDir("aec-s-system-outbox-"));
  const project = db.createProject({ name: "outbox delivery", repoPath: createGitRepository() });
  db.createDecision({
    projectId: project.id,
    kind: "direction",
    title: "Human exception",
    body: "Direction is required",
  });
  let succeed = false;
  let currentTime = new Date("2026-01-01T00:00:00.000Z");
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return {
      exitCode: succeed ? 0 : 1,
      signal: null,
      stdout: "",
      stderr: succeed ? "" : "notification unavailable",
      timedOut: false,
    };
  };
  assert.equal(await deliverSystemOutboxOnce(db, execute, () => currentTime), 0);
  let message = db.listOutbox(project.id).find((candidate) => candidate.channel === "system")!;
  assert.equal(message.status, "pending");
  assert.equal(message.attempts, 1);
  assert.equal(message.nextAttemptAt, "2026-01-01T00:00:05.000Z");
  assert.equal(await deliverSystemOutboxOnce(db, execute, () => currentTime), 0);
  assert.equal(executions, 1, "backoff must prevent a hot retry loop");
  succeed = true;
  currentTime = new Date("2026-01-01T00:00:05.000Z");
  assert.equal(await deliverSystemOutboxOnce(db, execute, () => currentTime), 1);
  message = db.listOutbox(project.id).find((candidate) => candidate.channel === "system")!;
  assert.equal(message.status, "delivered");
  assert.equal(message.attempts, 2);
  assert.equal(message.nextAttemptAt, undefined);
  db.close();
});

test("recovers an Outbox delivery whose delivering lease expired", async () => {
  const db = new AecSDatabase(tempDir("aec-s-system-outbox-recovery-"));
  const project = db.createProject({ name: "outbox recovery", repoPath: createGitRepository() });
  db.createDecision({ projectId: project.id, kind: "direction", title: "Recover", body: "Deliver once" });
  const message = db.listDeliverableOutbox("system", "2026-01-01T00:00:00.000Z")[0]!;
  assert.ok(db.claimOutboxDelivery(message.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z"));
  assert.equal(db.listDeliverableOutbox("system", "2026-01-01T00:00:29.000Z").length, 0);
  assert.equal(db.listDeliverableOutbox("system", "2026-01-01T00:00:30.000Z").length, 1);
  assert.equal(await deliverSystemOutboxOnce(db, async () => ({
    exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false,
  }), () => new Date("2026-01-01T00:00:30.000Z")), 1);
  assert.equal(db.listOutbox(project.id).find((candidate) => candidate.id === message.id)?.attempts, 2);
  db.close();
});

test("keeps the system Outbox loop alive across transient database failures", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const failingDb = {
    listDeliverableOutbox() {
      attempts += 1;
      if (attempts >= 2) controller.abort();
      throw new Error("database is temporarily locked");
    },
  } as unknown as AecSDatabase;
  await systemOutboxLoop(failingDb, controller.signal, 1);
  assert.equal(attempts, 2);
});
