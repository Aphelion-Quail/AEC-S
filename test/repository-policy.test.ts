import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

test("repository examples use a rejected path sentinel", () => {
  for (const filename of ["project.github.json", "project.local.json"]) {
    const project = JSON.parse(readFileSync(join(root, "examples", filename), "utf8")) as { repoPath?: string };
    assert.equal(project.repoPath, "__AEC_S_REPOSITORY_PATH_REQUIRED__");
  }
});

test("GitHub Actions are pinned to immutable release commits", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v\d+/);
});

test("DSH compositions fail closed when required workspace state is absent", () => {
  const executor = readFileSync(join(root, "runtime", "dsh", "executor.cordis.yml"), "utf8");
  const reviewer = readFileSync(join(root, "runtime", "dsh", "reviewer.cordis.yml"), "utf8");
  assert.match(executor, /DSH_CWD is required/);
  assert.match(executor, /DSH_SESSION_ROOT is required/);
  assert.match(reviewer, /DSH_CWD/);
  assert.match(reviewer, /DSH_SESSION_ROOT is required/);
  assert.doesNotMatch(executor, /DSH_CWD\s*\?\?\s*process\.cwd/);
});

test("live Runtime gate formats unexpected failures through the shared redactor", async () => {
  const script = pathToFileURL(join(root, "scripts", "test-runtimes-live.mjs")).href;
  const module = await import(script) as {
    formatLiveGateError(error: unknown): string;
    assertSanitizedReport(report: unknown): void;
  };
  const secret = `sk-${"a".repeat(24)}`;
  const formatted = module.formatLiveGateError(new Error(`Runtime failed with ${secret}`));
  assert.equal(formatted.includes(secret), false);
  assert.match(formatted, /\[REDACTED\]/);
  assert.doesNotThrow(() => module.assertSanitizedReport({
    schemaVersion: 2,
    aecSVersion: "0.9.0-rc.3",
    runtimeVersions: { codex: "1", kimi: "1", deepseek_harness: "1" },
    scenarios: [{ id: "LIVE-FIXTURE", status: "PASS" }],
    result: "PASS",
    completedAt: "2026-08-19T00:00:00.000Z",
  }));
  assert.throws(() => module.assertSanitizedReport({
    schemaVersion: 2,
    aecSVersion: "0.9.0-rc.3",
    runtimeVersions: {},
    scenarios: [],
    result: "PASS",
    completedAt: "2026-08-19T00:00:00.000Z",
    sessionId: "must-not-appear",
  }), /unsupported field|forbidden field/);
});
