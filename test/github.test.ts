import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AecSDatabase } from "../src/db.js";
import { AecSEngine } from "../src/engine.js";
import { inspectRequiredChecks, mergePullRequest, waitForRequiredChecks } from "../src/github.js";
import { branchHead, commitTask, createWorktree } from "../src/git.js";
import { createGitRepository, fixturePath, tempDir } from "./helpers.js";
import type { Project, Run, Workspace } from "../src/types.js";

const fakeAgent = fixturePath("fake-agent.js");

test("publishes one idempotent PR and records the remote merge", async () => {
  const repo = createGitRepository();
  const remote = tempDir("aec-s-remote-");
  execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });

  const fakeBin = tempDir("aec-s-fakebin-");
  const ghState = join(fakeBin, "gh-state.json");
  const ghPath = join(fakeBin, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const read = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
const write = value => fs.writeFileSync(statePath, JSON.stringify(value));
const remoteHead = () => cp.execFileSync('git', ['ls-remote', '--heads', 'origin', 'refs/heads/aec-s/task-github'], { encoding: 'utf8' }).trim().split(/\\s+/)[0];
if (args[0] === 'pr' && args[1] === 'list') {
  const state = read();
  const head = state ? remoteHead() : undefined;
  if (state && head) write({ ...state, head });
  process.stdout.write(JSON.stringify(state ? [{ number: 1, url: 'https://example.test/pr/1', state: state.state, headRefOid: head }] : []));
} else if (args[0] === 'pr' && args[1] === 'create') {
  write({ state: 'OPEN', head: remoteHead(), checks: 0 });
  process.stdout.write('https://example.test/pr/1\\n');
} else if (args[0] === 'pr' && args[1] === 'checks') {
  const state = read();
  if (state.checks === 0) {
    write({ ...state, checks: 1 });
    process.stderr.write('no checks reported on the branch');
    process.exit(1);
  } else if (state.checks === 1) {
    write({ ...state, checks: 2 });
    process.stdout.write(JSON.stringify([{ name: 'test', state: 'FAILURE', bucket: 'fail' }]));
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify([{ name: 'test', state: 'SUCCESS', bucket: 'pass' }]));
  }
} else if (args[0] === 'pr' && args[1] === 'merge') {
  const state = read();
  const matchIndex = args.indexOf('--match-head-commit');
  const expected = matchIndex >= 0 ? args[matchIndex + 1] : undefined;
  const actual = remoteHead();
  if (!expected || expected !== actual) {
    process.stderr.write('head commit mismatch');
    process.exit(1);
  }
  cp.execFileSync('git', ['push', '--force', 'origin', actual + ':refs/heads/main'], { stdio: 'ignore' });
  write({ ...state, state: 'MERGED', head: actual, mergeSha: actual });
} else if (args[0] === 'pr' && args[1] === 'view') {
  const state = read();
  process.stdout.write(JSON.stringify({ number: 1, url: 'https://example.test/pr/1', state: state.state, headRefOid: state.head, mergeCommit: state.mergeSha ? { oid: state.mergeSha } : null }));
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
  process.env.AEC_S_GITHUB_CHECK_POLL_MS = "10";
  try {
    const db = new AecSDatabase(tempDir("aec-s-github-"));
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
        repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
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
    const engine = new AecSEngine(db);
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
    for (let cycle = 0; cycle < 20 && db.getTask(task!.id)?.status !== "succeeded"; cycle += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 275));
      await engine.runOnce();
    }
    assert.equal(db.getTask(task!.id)?.status, "succeeded");
    assert.equal(
      db.getTask(task!.id)?.mergeSha,
      execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(),
    );
    const run = db.getLatestRunForTask(task!.id)!;
    assert.equal(run.effects.pullRequest?.status, "completed");
    assert.equal(run.effects.merge?.status, "completed");
    assert.equal(run.review?.reviewerAgentId, "reviewer");
    assert.equal(
      execFileSync("git", ["--git-dir", remote, "show", "refs/heads/main:remote.txt"], { encoding: "utf8" }),
      "repaired\n",
    );
    assert.equal(
      Number(execFileSync("git", ["--git-dir", remote, "rev-list", "--count", "refs/heads/main"], { encoding: "utf8" }).trim()),
      3,
    );
    assert.throws(() => execFileSync("git", ["--git-dir", remote, "show-ref", "--verify", "refs/heads/aec-s/task-github"], { stdio: "ignore" }));
    await engine.runTask(task!.id);
    assert.equal(db.listRuns(task!.id).length, 1);
    db.close();
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FAKE_GH_STATE;
    delete process.env.AEC_S_GITHUB_CHECK_POLL_MS;
  }
});

test("reconciles an externally completed PR before retrying publish", async () => {
  const repo = createGitRepository();
  const remote = tempDir("aec-s-reconcile-remote-");
  execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });

  const fakeBin = tempDir("aec-s-reconcile-fakebin-");
  const ghPath = join(fakeBin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 7,
    url: 'https://example.test/pr/7',
    state: 'MERGED',
    headRefOid: process.env.FAKE_GH_HEAD,
    mergeCommit: { oid: process.env.FAKE_GH_MERGE }
  }));
  process.exit(0);
}
process.stderr.write('unexpected GitHub mutation: ' + args.join(' '));
process.exit(2);
`);
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

  const home = tempDir("aec-s-reconcile-home-");
  const db = new AecSDatabase(home);
  try {
    const project = db.createProject({
      id: "github-reconcile",
      name: "GitHub reconciliation",
      repoPath: repo,
      deliveryMode: "github",
      requiredChecks: ["verify"],
    });
    const agent = db.createAgent({
      id: "executor",
      name: "must-not-run",
      adapter: "command",
      roles: ["executor"],
      maxConcurrency: 1,
      config: { binary: process.execPath },
    });
    const engine = new AecSEngine(db, { operationalRetryBaseMs: 1 });
    const [task] = engine.submitGraph(project.id, [{
      id: "task-reconcile",
      projectId: project.id,
      title: "Reconcile merged PR",
      goal: "Record an already completed GitHub merge",
      scope: { writeGlobs: ["remote.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["The completed PR is reconciled without another publish"],
    }]);
    engine.promoteTasks();
    const baseSha = await branchHead(repo, "main");
    const runId = "run-reconcile";
    const workspaceId = "workspace-reconcile";
    const workspacePath = join(home, "workspaces", project.id, task!.id, runId);
    const logDir = join(home, "runs", runId);
    mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const run: Run = {
      id: runId,
      taskId: task!.id,
      agentId: agent.id,
      workspaceId,
      phase: "prepare",
      status: "active",
      attempt: 1,
      repairCount: 1,
      rotationCount: 0,
      baseSha,
      validation: [],
      effects: {},
      logDir,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const workspace: Workspace = {
      id: workspaceId,
      projectId: project.id,
      taskId: task!.id,
      runId,
      path: workspacePath,
      branch: `aec-s/${task!.id}`,
      baseSha,
      status: "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.createRun(run);
    db.createWorkspace(workspace);
    db.updateTaskStatus(task!.id, "running");
    await createWorktree(project, workspace.path, workspace.branch);
    writeFileSync(join(workspace.path, "remote.txt"), "merged remotely\n");
    const pullRequestHead = await commitTask(workspace.path, task!);
    execFileSync("git", ["push", "origin", `${pullRequestHead}:refs/heads/${workspace.branch}`], {
      cwd: workspace.path,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", `${pullRequestHead}:refs/heads/main`], {
      cwd: workspace.path,
      stdio: "ignore",
    });
    process.env.FAKE_GH_HEAD = pullRequestHead;
    process.env.FAKE_GH_MERGE = pullRequestHead;
    run.phase = "publish";
    run.status = "interrupted";
    run.effects = {
      commit: { operationId: `${project.id}:${task!.id}:${run.id}:commit`, status: "completed", externalRef: pullRequestHead },
      push: { operationId: `${project.id}:${task!.id}:${run.id}:push`, status: "uncertain" },
      pullRequest: { operationId: `${project.id}:${task!.id}:${run.id}:pullRequest`, status: "completed", externalRef: "https://example.test/pr/7#7" },
      merge: { operationId: `${project.id}:${task!.id}:${run.id}:merge`, status: "pending" },
    };
    run.error = {
      phase: "publish",
      message: "stale branch",
      operationalRetry: { count: 1, nextAttemptAt: new Date(0).toISOString(), message: "stale branch" },
    };
    db.saveRun(run);
    db.updateWorkspaceStatus(workspace.id, "preserved");
    db.updateTaskStatus(task!.id, "operational_blocked", { summary: "Retry scheduled" });

    await engine.runOnce();

    assert.equal(db.getTask(task!.id)?.status, "succeeded");
    assert.equal(db.getTask(task!.id)?.mergeSha, pullRequestHead);
    assert.equal(db.getLatestRunForTask(task!.id)?.effects.merge?.status, "completed");
    assert.equal(db.getLatestRunForTask(task!.id)?.status, "completed");
    assert.equal(db.getWorkspace(workspace.id)?.status, "cleaned");
    assert.throws(() => execFileSync("git", ["--git-dir", remote, "show-ref", "--verify", `refs/heads/${workspace.branch}`], { stdio: "ignore" }));
  } finally {
    db.close();
    process.env.PATH = oldPath;
    delete process.env.FAKE_GH_HEAD;
    delete process.env.FAKE_GH_MERGE;
  }
});

function githubProject(repoPath: string, requiredChecks: string[]): Project {
  return {
    id: "github-negative",
    name: "github negative paths",
    repoPath,
    targetBranch: "main",
    remoteName: "origin",
    deliveryMode: "github",
    intent: "",
    defaultValidation: [],
    fullValidation: [],
    requiredChecks,
    highRiskGlobs: [],
    maxConcurrency: 2,
    createdAt: new Date().toISOString(),
  };
}

test("rejects missing required checks before querying GitHub", async () => {
  const repo = createGitRepository();
  await assert.rejects(waitForRequiredChecks(githubProject(repo, []), repo, 1, 1, undefined, 1), /at least one/);
});

test("does not treat a skipped required GitHub check as passing", async () => {
  const repo = createGitRepository();
  const fakeBin = tempDir("aec-s-skipped-gh-");
  const ghPath = join(fakeBin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify([{ name: 'test', state: 'SKIPPED', bucket: 'skipping' }]));
`);
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  try {
    assert.equal(await inspectRequiredChecks(githubProject(repo, ["test"]), repo, 1), "pending");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("fails closed on GitHub authentication errors and unexpected merged heads", async () => {
  const repo = createGitRepository();
  const fakeBin = tempDir("aec-s-failing-gh-");
  const ghPath = join(fakeBin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'checks') {
  process.stderr.write('authentication required');
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ number: 1, url: 'https://example.test/pr/1', state: 'MERGED', headRefOid: 'wrong-head', mergeCommit: { oid: 'merge-sha' } }));
  process.exit(0);
}
process.exit(2);
`);
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  try {
    await assert.rejects(
      waitForRequiredChecks(githubProject(repo, ["test"]), repo, 1, 1, undefined, 1),
      /authentication required/,
    );
    await assert.rejects(mergePullRequest(repo, 1, "expected-head"), /unexpected head wrong-head/);
  } finally {
    process.env.PATH = oldPath;
  }
});
