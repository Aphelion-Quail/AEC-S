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

test("redacts private keys, cloud identifiers, JWTs, and Slack tokens", () => {
  const aws = `AKIA${"A1".repeat(8)}`;
  const slack = `xoxb-${"abc123".repeat(4)}`;
  const jwt = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(12)].join(".");
  const pem = [`-----BEGIN ${"PRIVATE KEY"}-----`, "not-real-key-material", `-----END ${"PRIVATE KEY"}-----`].join("\n");
  const redacted = redactText([aws, slack, jwt, pem].join("\n"));
  for (const secret of [aws, slack, jwt, "not-real-key-material"]) assert.equal(redacted.includes(secret), false);
  assert.deepEqual(redactJson({ authorization: "opaque-value" }), { authorization: "[REDACTED]" });
});

test("redacts JSON secrets, Google API keys, and non-HTTP credential URLs", () => {
  const google = `AIza${"a".repeat(35)}`;
  const input = `{"api_key": "${google}", "database": "postgresql://user:password@db.test/name"}`;
  const redacted = redactText(input);
  assert.equal(redacted.includes(google), false);
  assert.equal(redacted.includes("password"), false);
  assert.match(redacted, /"api_key": "\[REDACTED\]"/);
  assert.doesNotMatch(redactText(`DEEPSEEK_API_KEY: '${"x".repeat(32)}'`), /xxxxxxxx/);
});

test("preserves token usage metrics while covering additional provider tokens", () => {
  const metrics = { tokenUsage: { input: 12, output: 8, total: 20 } };
  assert.deepEqual(redactJson(metrics), metrics);
  const secrets = [`glpat-${"a".repeat(24)}`, `xapp-${"b".repeat(24)}`, `npm_${"c".repeat(36)}`];
  const redacted = redactText(secrets.join(" "));
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
});

test("uses one secret-key vocabulary for camelCase JSON and quoted assignments", () => {
  assert.deepEqual(redactJson({
    clientSecret: "client-value",
    sessionToken: "session-value",
    authToken: "auth-value",
    apiKey: "api-value",
    tokenUsage: { input: 1, output: 2, total: 3 },
  }), {
    clientSecret: "[REDACTED]",
    sessionToken: "[REDACTED]",
    authToken: "[REDACTED]",
    apiKey: "[REDACTED]",
    tokenUsage: { input: 1, output: 2, total: 3 },
  });
  const redacted = redactText(`PASSWORD="hunter2 extra words" AUTH_TOKEN='one two three'`);
  assert.equal(redacted, "PASSWORD=[REDACTED] AUTH_TOKEN=[REDACTED]");
});
