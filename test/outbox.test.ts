import test from "node:test";
import assert from "node:assert/strict";
import { AecSDatabase } from "../src/db.js";
import { deliverSystemOutboxOnce } from "../src/outbox.js";
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
  const execute = async () => ({
    exitCode: succeed ? 0 : 1,
    signal: null,
    stdout: "",
    stderr: succeed ? "" : "notification unavailable",
    timedOut: false,
  });
  assert.equal(await deliverSystemOutboxOnce(db, execute), 0);
  assert.equal(db.listOutbox(project.id).find((message) => message.channel === "system")?.status, "pending");
  succeed = true;
  assert.equal(await deliverSystemOutboxOnce(db, execute), 1);
  assert.equal(db.listOutbox(project.id).find((message) => message.channel === "system")?.status, "delivered");
  db.close();
});
