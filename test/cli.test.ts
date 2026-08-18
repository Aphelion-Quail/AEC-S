import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtCliPath, createGitRepository, tempDir } from "./helpers.js";

const cli = builtCliPath();

function invoke(home: string, args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    env: { ...process.env, AEC_S_HOME: home },
    encoding: "utf8",
  })) as Record<string, unknown>;
}

test("advertises the AEC-S command name", () => {
  const result = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^AEC-S commands:/);
  assert.match(result.stderr, /aec-s doctor/);
  assert.doesNotMatch(result.stderr, /^  aec doctor$/m);
});

test("manages Project and Agent configuration through the CLI and reports doctor state", () => {
  const home = tempDir("aec-s-cli-home-");
  const inputs = tempDir("aec-s-cli-input-");
  const projectPath = join(inputs, "project.json");
  const projectPatchPath = join(inputs, "project-patch.json");
  const agentPath = join(inputs, "agent.json");
  const agentPatchPath = join(inputs, "agent-patch.json");
  const repo = createGitRepository();
  writeFileSync(projectPath, JSON.stringify({ id: "cli-project", name: "CLI", repoPath: repo }));
  writeFileSync(projectPatchPath, JSON.stringify({ intent: "Updated through CLI", intentVersion: 2, maxConcurrency: 3 }));
  writeFileSync(agentPath, JSON.stringify({
    id: "cli-agent",
    name: "CLI Agent",
    adapter: "command",
    roles: ["executor"],
    config: { binary: process.execPath },
  }));
  writeFileSync(agentPatchPath, JSON.stringify({ availability: "degraded", enabled: false }));

  assert.equal(invoke(home, ["project", "add", projectPath]).id, "cli-project");
  assert.equal(invoke(home, ["project", "show", "cli-project"]).name, "CLI");
  assert.equal(invoke(home, ["project", "update", "cli-project", projectPatchPath]).intent, "Updated through CLI");
  assert.ok(Array.isArray(invoke(home, ["project", "list"]).projects));
  assert.equal(invoke(home, ["agent", "add", agentPath]).id, "cli-agent");
  assert.equal(invoke(home, ["agent", "show", "cli-agent"]).name, "CLI Agent");
  assert.equal(invoke(home, ["agent", "update", "cli-agent", agentPatchPath]).availability, "disabled");
  assert.ok(Array.isArray(invoke(home, ["agent", "list"]).agents));
  assert.equal(invoke(home, ["doctor"]).ok, true);
  writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  const unhealthy = invoke(home, ["doctor"]);
  assert.equal(unhealthy.ok, false);
  assert.match(JSON.stringify(unhealthy.projects), /uncommitted changes/);
});
