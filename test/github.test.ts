import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { AecDatabase } from "../src/db.js";
import { AecEngine } from "../src/engine.js";
import { createGitRepository, tempDir } from "./helpers.js";

const fakeAgent = resolve("dist/test/fixtures/fake-agent.js");

test("publishes one idempotent PR and records the remote merge", async () => {
  const repo = createGitRepository();
  const remote = tempDir("aec-remote-");
  execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });

  const fakeBin = tempDir("aec-fakebin-");
  const ghState = join(fakeBin, "gh-state.json");
  const ghPath = join(fakeBin, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const read = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
const write = value => fs.writeFileSync(statePath, JSON.stringify(value));
if (args[0] === 'pr' && args[1] === 'list') {
  const state = read();
  process.stdout.write(JSON.stringify(state ? [{ number: 1, url: 'https://example.test/pr/1', state: state.state, headRefOid: state.head }] : []));
} else if (args[0] === 'pr' && args[1] === 'create') {
  write({ state: 'OPEN', head: 'head' });
  process.stdout.write('https://example.test/pr/1\\n');
} else if (args[0] === 'pr' && args[1] === 'checks') {
  process.stdout.write(JSON.stringify([{ name: 'test', state: 'SUCCESS', bucket: 'pass' }]));
} else if (args[0] === 'pr' && args[1] === 'merge') {
  write({ state: 'MERGED', head: 'head' });
} else if (args[0] === 'pr' && args[1] === 'view') {
  const state = read();
  process.stdout.write(JSON.stringify({ number: 1, url: 'https://example.test/pr/1', state: state.state, headRefOid: state.head, mergeCommit: state.state === 'MERGED' ? { oid: '1111111111111111111111111111111111111111' } : null }));
} else {
  process.stderr.write('unsupported fake gh command: ' + args.join(' '));
  process.exit(1);
}
`,
  );
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  process.env.FAKE_GH_STATE = ghState;
  try {
    const db = new AecDatabase(tempDir("aec-github-"));
    const project = db.createProject({
      name: "github",
      repoPath: repo,
      deliveryMode: "github",
      requiredChecks: ["test"],
    });
    db.createAgent({
      id: "executor",
      name: "fake-worker",
      adapter: "command",
      roles: ["executor"],
      maxConcurrency: 1,
      config: {
        binary: process.execPath,
        execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
      },
    });
    db.createAgent({
      id: "reviewer",
      name: "fake-reviewer",
      adapter: "command",
      roles: ["reviewer"],
      config: {
        binary: process.execPath,
        review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
      },
    });
    const engine = new AecEngine(db);
    const [task] = engine.submitGraph(project.id, [
      {
        id: "task-github",
        projectId: project.id,
        title: "GitHub delivery",
        goal: "Create remote.txt",
        scope: { writeGlobs: ["remote.txt"], impactGlobs: [], tags: [] },
        acceptanceCriteria: ["Remote PR merges"],
      },
    ]);
    await engine.runTask(task!.id);
    assert.equal(db.getTask(task!.id)?.status, "succeeded");
    assert.equal(db.getTask(task!.id)?.mergeSha, "1111111111111111111111111111111111111111");
    const run = db.getLatestRunForTask(task!.id)!;
    assert.equal(run.effects.pullRequest?.status, "completed");
    assert.equal(run.effects.merge?.status, "completed");
    assert.equal(run.review?.reviewerAgentId, "reviewer");
    await engine.runTask(task!.id);
    assert.equal(db.listRuns(task!.id).length, 1);
    db.close();
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FAKE_GH_STATE;
  }
});
