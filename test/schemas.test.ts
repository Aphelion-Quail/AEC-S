import test from "node:test";
import assert from "node:assert/strict";
import { reviewResultSchema, workerResultSchema } from "../src/schemas.js";

test("Codex output schemas require every property and encode optional values as nullable", () => {
  assert.deepEqual(workerResultSchema.required, ["status", "summary", "notes", "blocker"]);
  assert.deepEqual(workerResultSchema.properties.blocker.type, ["object", "null"]);
  const finding = reviewResultSchema.properties.findings.items;
  assert.deepEqual(finding.required, ["severity", "summary", "file", "line", "requiredChange"]);
  assert.deepEqual(finding.properties.file.type, ["string", "null"]);
  assert.deepEqual(finding.properties.line.type, ["integer", "null"]);
  assert.deepEqual(finding.properties.requiredChange.type, ["string", "null"]);
});
