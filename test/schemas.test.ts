import test from "node:test";
import assert from "node:assert/strict";
import { reviewResultSchema, workerResultSchema } from "../src/schemas.js";
import { projectInputSchema } from "../src/input.js";

test("Codex output schemas require every property and encode optional values as nullable", () => {
  assert.deepEqual(workerResultSchema.required, ["status", "summary", "notes", "blocker", "scopeExpansion"]);
  assert.equal(workerResultSchema.additionalProperties, false);
  assert.deepEqual(workerResultSchema.properties.status.enum, ["complete", "blocked"]);
  assert.deepEqual(workerResultSchema.properties.blocker.type, ["object", "null"]);
  assert.equal(workerResultSchema.properties.blocker.additionalProperties, false);
  assert.deepEqual(workerResultSchema.properties.blocker.required, ["kind", "question"]);
  assert.deepEqual(workerResultSchema.properties.blocker.properties.kind.enum, [
    "technical", "architecture", "product", "tradeoff",
  ]);
  assert.equal(reviewResultSchema.additionalProperties, false);
  assert.deepEqual(workerResultSchema.properties.scopeExpansion.type, ["object", "null"]);
  assert.deepEqual(reviewResultSchema.required, ["verdict", "completed", "summary", "findings"]);
  assert.deepEqual(reviewResultSchema.properties.verdict.enum, ["pass", "fail", null]);
  const finding = reviewResultSchema.properties.findings.items;
  assert.equal(finding.additionalProperties, false);
  assert.deepEqual(finding.required, ["severity", "summary", "file", "line", "requiredChange", "evidence", "category"]);
  assert.deepEqual(finding.properties.severity.enum, ["blocking", "warning"]);
  assert.deepEqual(finding.properties.file.type, ["string", "null"]);
  assert.deepEqual(finding.properties.line.type, ["integer", "null"]);
  assert.equal(finding.properties.line.minimum, 1);
  assert.deepEqual(finding.properties.requiredChange.type, ["string", "null"]);
});

test("rejects dot as an invalid Git target ref", () => {
  assert.throws(() => projectInputSchema.parse({ name: "invalid-ref", repoPath: "/tmp/repo", targetBranch: "." }), /safe Git branch/);
});
