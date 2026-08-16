import test from "node:test";
import assert from "node:assert/strict";
import { adapterFor } from "../src/adapters/agent.js";
import type { Agent } from "../src/types.js";
import { tempDir } from "./helpers.js";

const agent: Agent = {
  id: "codex",
  name: "Codex",
  adapter: "codex",
  roles: ["executor", "reviewer"],
  capabilities: [],
  enabled: true,
  availability: "available",
  maxConcurrency: 1,
  currentLoad: 0,
  config: { binary: "codex", ignoreUserConfig: true },
};

test("applies the same explicit Codex workspace boundary to fresh and resumed writes", () => {
  const workspace = tempDir("aec-codex-workspace-");
  const runDir = tempDir("aec-codex-run-");
  const adapter = adapterFor(agent);
  const fresh = adapter.invocation({
    kind: "execute",
    prompt: "execute",
    workspacePath: workspace,
    runDir,
    schemaPath: `${runDir}/worker.json`,
  });
  const resumed = adapter.invocation({
    kind: "repair",
    prompt: "repair",
    workspacePath: workspace,
    runDir,
    schemaPath: `${runDir}/worker.json`,
    sessionId: "00000000-0000-0000-0000-000000000001",
  });
  for (const invocation of [fresh, resumed]) {
    assert.equal(invocation.command.cwd, workspace);
    assert.deepEqual(invocation.command.args.slice(0, 8), [
      "--ask-for-approval", "never", "--sandbox", "workspace-write", "--cd", workspace, "exec", invocation === resumed ? "resume" : "--json",
    ]);
  }
});

test("forces independent Codex review into a read-only workspace", () => {
  const workspace = tempDir("aec-codex-review-");
  const runDir = tempDir("aec-codex-review-run-");
  const invocation = adapterFor(agent).invocation({
    kind: "review",
    prompt: "review",
    workspacePath: workspace,
    runDir,
    schemaPath: `${runDir}/review.json`,
  });
  assert.deepEqual(invocation.command.args.slice(0, 7), [
    "--ask-for-approval", "never", "--sandbox", "read-only", "--cd", workspace, "exec",
  ]);
});
