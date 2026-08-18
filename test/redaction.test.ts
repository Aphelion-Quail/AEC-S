import test from "node:test";
import assert from "node:assert/strict";
import { redactJson, redactText } from "../src/redaction.js";

test("redacts common credentials before errors and Agent evidence are persisted", () => {
  const github = `ghp_${"a".repeat(30)}`;
  const bearer = `Bearer ${"test".repeat(6)}`;
  const input = `${bearer} TOKEN=${github} https://user:password@example.test/path`;
  const redacted = redactText(input);
  assert.equal(redacted.includes(bearer), false);
  assert.doesNotMatch(redacted, /ghp_|password/);
  assert.match(redacted, /REDACTED/);
  assert.deepEqual(redactJson({ nested: [input] }), { nested: [redacted] });
});
