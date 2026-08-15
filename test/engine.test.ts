import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AecDatabase } from "../src/db.js";
import { AecEngine } from "../src/engine.js";
import { createGitRepository, fixturePath, tempDir } from "./helpers.js";

const fakeAgent = fixturePath("fake-agent.js");

function registerFakeAgents(db: AecDatabase, executeMode = "execute", reviewMode = "review"): void {
  db.createAgent({
    id: "executor",
    name: "executor",
    adapter: "command",
    roles: ["executor"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, executeMode, "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, reviewMode, "{workspace}", "{output}"] },
    },
  });
}

async function runScheduledPair(input: {
  globalConcurrency: number;
  projectConcurrency: number;
  conflicting?: boolean;
}): Promise<string[]> {
  const repo = createGitRepository();
  const home = tempDir("aec-scheduler-pair-");
  const timeline = join(home, "timeline.txt");
  const db = new AecDatabase(home);
  const project = db.createProject({
    name: "scheduler-pair",
    repoPath: repo,
    maxConcurrency: input.projectConcurrency,
  });
  db.createAgent({
    id: "pair-executor",
    name: "pair executor",
    adapter: "command",
    roles: ["executor"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "timeline-fast", "{workspace}", "{output}", timeline] },
    },
  });
  db.createAgent({
    id: "pair-reviewer",
    name: "pair reviewer",
    adapter: "command",
    roles: ["reviewer"],
    maxConcurrency: 2,
    config: { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } },
  });
  const engine = new AecEngine(db, { globalConcurrency: input.globalConcurrency });
  engine.submitGraph(project.id, [
    {
      id: "pair-one",
      projectId: project.id,
      title: "Pair one",
      goal: "Create one/result.txt",
      scope: { writeGlobs: ["one/result.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["one exists"],
    },
    {
      id: "pair-two",
      projectId: project.id,
      title: "Pair two",
      goal: "Create two/result.txt",
      scope: {
        writeGlobs: ["two/result.txt"],
        impactGlobs: input.conflicting ? ["one/**"] : [],
        tags: [],
      },
      acceptanceCriteria: ["two exists"],
    },
  ]);
  await engine.runUntilIdle();
  const entries = readFileSync(timeline, "utf8").trim().split(/\r?\n/);
  db.close();
  return entries;
}

test("runs two independent tasks without invalidating the second on HEAD change", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-home-");
  const db = new AecDatabase(home);
  const project = db.createProject({
    name: "parallel-fixture",
    repoPath: repo,
    defaultValidation: [{ program: process.execPath, args: ["-e", "process.exit(0)"] }],
    fullValidation: [{ program: process.execPath, args: ["-e", "require('node:fs').writeFileSync('FULL_RAN','yes')"] }],
    highRiskGlobs: ["shared/**"],
    maxConcurrency: 2,
  });
  const uiValidationCount = join(home, "ui-validation-count.txt");
  const coreValidationCount = join(home, "core-validation-count.txt");
  const executionTimeline = join(home, "execution-timeline.txt");
  db.createAgent({
    id: "executor",
    name: "fake-worker",
    adapter: "command",
    roles: ["executor"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "timeline-slow", "{workspace}", "{output}", executionTimeline] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "fake-reviewer",
    adapter: "command",
    roles: ["reviewer"],
    maxConcurrency: 2,
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecEngine(db, { globalConcurrency: 2 });
  const tasks = engine.submitGraph(project.id, [
    {
      id: "task-ui",
      projectId: project.id,
      title: "Add UI",
      goal: "Create ui/result.txt",
      scope: { writeGlobs: ["ui/result.txt"], impactGlobs: [], tags: ["ui"] },
      acceptanceCriteria: ["UI file exists"],
      validationCommands: [{
        program: process.execPath,
        args: ["-e", `const fs=require('node:fs');fs.accessSync('ui/result.txt');const p=${JSON.stringify(uiValidationCount)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1))`],
      }],
    },
    {
      id: "task-core",
      projectId: project.id,
      title: "Add Core",
      goal: "Create core/result.txt",
      scope: { writeGlobs: ["core/result.txt"], impactGlobs: [], tags: ["core"] },
      acceptanceCriteria: ["Core file exists"],
      validationCommands: [{
        program: process.execPath,
        args: ["-e", `const fs=require('node:fs');fs.accessSync('core/result.txt');const p=${JSON.stringify(coreValidationCount)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1))`],
      }],
    },
  ]);
  await engine.runUntilIdle();
  for (const task of tasks) assert.equal(db.getTask(task.id)?.status, "succeeded");
  assert.equal(existsSync(join(repo, "ui/result.txt")), true);
  assert.equal(existsSync(join(repo, "core/result.txt")), true);
  assert.equal(existsSync(join(repo, "FULL_RAN")), false);
  assert.equal(readFileSync(uiValidationCount, "utf8"), "1", "unrelated HEAD changes must reuse UI validation");
  assert.equal(readFileSync(coreValidationCount, "utf8"), "1", "unrelated HEAD changes must reuse Core validation");
  const timeline = readFileSync(executionTimeline, "utf8").trim().split(/\r?\n/);
  assert.ok(timeline[0]?.endsWith(":start") && timeline[1]?.endsWith(":start"), "independent executor jobs must overlap");
  const log = execFileSync("git", ["log", "--format=%B"], { cwd: repo, encoding: "utf8" });
  assert.match(log, /AEC-Task: task-ui/);
  assert.match(log, /AEC-Task: task-core/);
  const runs = db.listRuns();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.validation.every((validation) => validation.status === "passed")));
  assert.ok(runs.every((run) => run.review?.verdict === "pass"));
  assert.ok(runs.every((run) => run.review?.reviewerAgentId !== run.agentId));
  assert.ok(runs.every((run) => readFileSync(run.diffPath!, "utf8").length > 0));
  assert.ok(runs.every((run) => db.getWorkspace(run.workspaceId)?.baseSha === run.baseSha));
  await engine.runTask(tasks[0]!.id);
  assert.equal(db.listRuns().length, 2, "rerunning a succeeded task must not create another Run");
  db.close();
});

test("revalidates only the current task after a related target-branch change", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-related-head-");
  const validationCount = join(home, "validation-count.txt");
  const db = new AecDatabase(home);
  const project = db.createProject({
    name: "related-head",
    repoPath: repo,
    fullValidation: [{ program: process.execPath, args: ["-e", "require('node:fs').writeFileSync('FULL_RAN','yes')"] }],
    highRiskGlobs: ["critical/**"],
  });
  db.createAgent({
    id: "executor",
    name: "slow executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "slow", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } },
  });
  const engine = new AecEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-related-head",
    projectId: project.id,
    title: "Handle related target change",
    goal: "Create feature.txt",
    scope: { writeGlobs: ["feature.txt"], impactGlobs: ["shared.txt"], tags: [] },
    acceptanceCriteria: ["Feature is merged after local revalidation"],
    validationCommands: [{
      program: process.execPath,
      args: ["-e", `const fs=require('node:fs');const p=${JSON.stringify(validationCount)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1))`],
    }],
  }]);
  const running = engine.runTask(task!.id);
  for (let index = 0; index < 80 && !db.getLatestRunForTask(task!.id)?.job; index += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.ok(db.getLatestRunForTask(task!.id)?.job, "the Agent job must be running before target HEAD changes");
  writeFileSync(join(repo, "shared.txt"), "related target change\n");
  execFileSync("git", ["add", "shared.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC Test", "-c", "user.email=aec-test@local", "commit", "-m", "related change"], {
    cwd: repo,
    stdio: "ignore",
  });
  await running;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(readFileSync(validationCount, "utf8"), "2", "related target changes must trigger local revalidation");
  assert.equal(existsSync(join(repo, "FULL_RAN")), false, "related but non-high-risk changes must not trigger full validation");
  const finalRun = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getWorkspace(finalRun.workspaceId)?.baseSha, finalRun.baseSha);
  db.close();
});

test("enforces global and Project scheduler concurrency limits", async () => {
  for (const limits of [
    { globalConcurrency: 1, projectConcurrency: 2 },
    { globalConcurrency: 2, projectConcurrency: 1 },
  ]) {
    const timeline = await runScheduledPair(limits);
    assert.equal(timeline.length, 4);
    assert.match(timeline[0]!, /:start$/);
    assert.match(timeline[1]!, /:end$/);
    assert.match(timeline[2]!, /:start$/);
    assert.match(timeline[3]!, /:end$/);
  }
});

test("serializes scheduler tasks whose declared Scopes conflict", async () => {
  const timeline = await runScheduledPair({ globalConcurrency: 2, projectConcurrency: 2, conflicting: true });
  assert.equal(timeline.length, 4);
  assert.match(timeline[0]!, /:start$/);
  assert.match(timeline[1]!, /:end$/);
  assert.match(timeline[2]!, /:start$/);
  assert.match(timeline[3]!, /:end$/);
});

test("renews the Run lease while an external phase remains active", async () => {
  const db = new AecDatabase(tempDir("aec-lease-heartbeat-"));
  const project = db.createProject({ name: "lease-heartbeat", repoPath: createGitRepository() });
  registerFakeAgents(db, "slow");
  const originalRenew = db.renewRunLease.bind(db);
  let renewals = 0;
  db.renewRunLease = (...args) => {
    renewals += 1;
    return originalRenew(...args);
  };
  const engine = new AecEngine(db, { leaseHeartbeatMs: 20 });
  const [task] = engine.submitGraph(project.id, [{
    id: "task-heartbeat",
    projectId: project.id,
    title: "Keep lease alive",
    goal: "Create heartbeat.txt",
    scope: { writeGlobs: ["heartbeat.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Run remains leased"],
  }]);
  await engine.runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.ok(renewals >= 10, `expected periodic lease renewals, received ${renewals}`);
  db.close();
});

test("records reprioritize through the same Task audit path", () => {
  const db = new AecDatabase(tempDir("aec-priority-audit-"));
  const project = db.createProject({ name: "priority-audit", repoPath: createGitRepository() });
  const engine = new AecEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-priority",
    projectId: project.id,
    title: "Change priority",
    goal: "Record priority changes",
    scope: { writeGlobs: ["priority.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Priority is durable"],
    priority: 1,
  }]);
  engine.applyDirective({ action: "reprioritize", taskIds: [task!.id], priority: 9 });
  assert.equal(db.getTask(task!.id)?.priority, 9);
  const event = db.listEvents(project.id).find((candidate) => candidate.type === "task.priority_changed");
  assert.deepEqual(event?.payload, { from: 1, to: 9 });
  db.close();
});

test("a paused active run does not occupy a scheduler slot", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-home-"));
  const project = db.createProject({ name: "pause-fixture", repoPath: repo });
  db.createAgent({
    name: "fake-worker",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "slow", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    name: "fake-reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecEngine(db);
  const [pausedTask, nextTask] = engine.submitGraph(project.id, [
    {
      id: "task-paused-active",
      projectId: project.id,
      title: "Paused active task",
      goal: "Create paused/result.txt",
      scope: { writeGlobs: ["paused/result.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["File exists"],
    },
    {
      id: "task-after-pause",
      projectId: project.id,
      title: "Task after pause",
      goal: "Create next/result.txt",
      scope: { writeGlobs: ["next/result.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["File exists"],
    },
  ]);
  const running = engine.runTask(pausedTask!.id);
  for (let index = 0; index < 80 && !db.getLatestRunForTask(pausedTask!.id)?.job; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(db.getLatestRunForTask(pausedTask!.id)?.job);
  engine.applyDirective({ action: "pause", taskIds: [pausedTask!.id] });
  await running;
  assert.equal(db.getTask(pausedTask!.id)?.status, "paused");
  assert.equal(db.getLatestRunForTask(pausedTask!.id)?.status, "active");
  await engine.runTask(nextTask!.id);
  assert.equal(db.getTask(nextTask!.id)?.status, "succeeded");
  db.close();
});

test("modifies an existing tracked file without inventing an out-of-scope path", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-tracked-"));
  const project = db.createProject({ name: "tracked", repoPath: repo });
  db.createAgent({
    id: "executor",
    name: "executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-tracked",
    projectId: project.id,
    title: "Update tracked file",
    goal: "Update README.md",
    scope: { writeGlobs: ["README.md"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["README changes"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.match(readFileSync(join(repo, "README.md"), "utf8"), /task-tracked/);
  db.close();
});

test("records failed authoritative validation and repairs it", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-validation-repair-"));
  const project = db.createProject({ name: "validation-repair", repoPath: repo });
  db.createAgent({
    id: "executor",
    name: "executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "bad", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-validation-repair",
    projectId: project.id,
    title: "Repair validation",
    goal: "Produce repaired.txt with repaired content",
    scope: { writeGlobs: ["repaired.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Validation passes"],
    validationCommands: [{
      program: process.execPath,
      args: ["-e", "if (!require('node:fs').readFileSync('repaired.txt','utf8').includes('repaired')) process.exit(3)"],
    }],
  }]);
  await new AecEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.repairCount, 1);
  assert.equal(run.validation.at(-1)?.status, "passed");
  assert.equal(readFileSync(join(repo, "repaired.txt"), "utf8"), "repaired\n");
  db.close();
});

test("records timed-out authoritative validation and repairs it", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-validation-timeout-"));
  const project = db.createProject({ name: "validation-timeout", repoPath: repo });
  db.createAgent({
    id: "executor",
    name: "executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "bad", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } },
  });
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-validation-timeout",
    projectId: project.id,
    title: "Repair timed-out validation",
    goal: "Produce repaired content",
    scope: { writeGlobs: ["repaired.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Validation passes after repair"],
    validationCommands: [{
      program: process.execPath,
      args: ["-e", "if (!require('node:fs').readFileSync('repaired.txt','utf8').includes('repaired')) setInterval(()=>{},1000)"],
      timeoutSeconds: 0.05,
    }],
  }]);
  await new AecEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.repairCount, 1);
  assert.equal(run.validation.at(-1)?.status, "passed");
  db.close();
});

test("repairs a blocking independent Review finding and reviews the new diff", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-review-repair-"));
  const project = db.createProject({ name: "review-repair", repoPath: repo });
  db.createAgent({
    id: "executor",
    name: "executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "bad", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review-file", "{workspace}", "{output}", "reviewed.txt"] },
    },
  });
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-review-repair",
    projectId: project.id,
    title: "Repair review finding",
    goal: "Produce reviewed content",
    scope: { writeGlobs: ["reviewed.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Review passes after repair"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.repairCount, 1);
  assert.equal(run.review?.verdict, "pass");
  assert.equal(readFileSync(join(repo, "reviewed.txt"), "utf8"), "repaired\n");
  db.close();
});

test("rotates to a second eligible executor after repair attempts are exhausted", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-agent-rotation-"));
  const project = db.createProject({ name: "agent-rotation", repoPath: repo });
  db.createAgent({
    id: "a-blocked",
    name: "blocked executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "blocked", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "blocked", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "b-working",
    name: "working executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
      repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "reviewer",
    name: "reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } },
  });
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-agent-rotation",
    projectId: project.id,
    title: "Rotate executor",
    goal: "Complete with the alternate executor",
    scope: { writeGlobs: ["rotated.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Alternate executor succeeds"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.rotationCount, 1);
  assert.equal(run.agentId, "b-working");
  db.close();
});

test("does not bypass the independent Review Gate when no reviewer is available", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-review-gate-"));
  const project = db.createProject({ name: "review-gate", repoPath: repo });
  db.createAgent({
    name: "executor-only",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
    },
  });
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-review-required",
    projectId: project.id,
    title: "Require review",
    goal: "Create review-required.txt",
    scope: { writeGlobs: ["review-required.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Independent review is required"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.match(String(db.getLatestRunForTask(task!.id)?.error?.message), /No independent reviewer/);
  assert.equal(existsSync(join(repo, "review-required.txt")), false);
  db.close();
});

test("runs configured full validation for a high-risk Task path", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-high-risk-");
  const fullMarker = join(home, "full-validation-ran.txt");
  const db = new AecDatabase(home);
  const project = db.createProject({
    name: "high-risk",
    repoPath: repo,
    highRiskGlobs: ["critical/**"],
    fullValidation: [{
      program: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(fullMarker)},'yes')`],
    }],
  });
  registerFakeAgents(db);
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-high-risk",
    projectId: project.id,
    title: "Change critical path",
    goal: "Create critical/state.txt",
    scope: { writeGlobs: ["critical/state.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Critical change is fully validated"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(readFileSync(fullMarker, "utf8"), "yes");
  db.close();
});

test("promotes DAG dependants only after their dependencies merge", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-dag-") );
  const project = db.createProject({ name: "dag", repoPath: repo });
  registerFakeAgents(db);
  const [first, second] = new AecEngine(db).submitGraph(project.id, [
    {
      id: "task-dag-first",
      projectId: project.id,
      title: "DAG first",
      goal: "Create first.txt",
      scope: { writeGlobs: ["first.txt"], impactGlobs: [], tags: [] },
      acceptanceCriteria: ["first merged"],
    },
    {
      id: "task-dag-second",
      projectId: project.id,
      title: "DAG second",
      goal: "Create second.txt after first",
      scope: { writeGlobs: ["second.txt"], impactGlobs: ["first.txt"], tags: [] },
      dependsOn: ["task-dag-first"],
      acceptanceCriteria: ["second sees first"],
      validationCommands: [{ program: process.execPath, args: ["-e", "require('node:fs').accessSync('first.txt')"] }],
    },
  ]);
  const engine = new AecEngine(db);
  await engine.runUntilIdle();
  assert.equal(db.getTask(first!.id)?.status, "succeeded");
  assert.equal(db.getTask(second!.id)?.status, "succeeded");
  assert.ok(db.getTask(first!.id)!.updatedAt <= db.getLatestRunForTask(second!.id)!.startedAt);
  db.close();
});

test("provides authoritative validation evidence to the independent reviewer", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-review-evidence-"));
  const project = db.createProject({
    name: "review-evidence",
    repoPath: repo,
    defaultValidation: [{ program: process.execPath, args: ["-e", "process.exit(0)"] }],
  });
  registerFakeAgents(db, "execute", "review-validation");
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-review-evidence",
    projectId: project.id,
    title: "Review evidence",
    goal: "Create evidence.txt",
    scope: { writeGlobs: ["evidence.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Reviewer receives evidence"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(db.getLatestRunForTask(task!.id)?.review?.summary, "Validation evidence received");
  db.close();
});

test("blocks a Reviewer adapter that mutates the task workspace", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-mutating-reviewer-"));
  const project = db.createProject({ name: "mutating-reviewer", repoPath: repo });
  registerFakeAgents(db, "execute", "review-mutate");
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-mutating-reviewer",
    projectId: project.id,
    title: "Reject mutating reviewer",
    goal: "Create safe.txt",
    scope: { writeGlobs: ["safe.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Reviewer remains read-only"],
  }]);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.match(db.getTask(task!.id)?.terminalSummary ?? "", /modified the task workspace/);
  assert.equal(existsSync(join(repo, "reviewer-leak.txt")), false);
  db.close();
});

test("refuses to commit out-of-scope files created by authoritative validation", async () => {
  const repo = createGitRepository();
  const db = new AecDatabase(tempDir("aec-post-validation-scope-"));
  const project = db.createProject({ name: "post-validation-scope", repoPath: repo });
  registerFakeAgents(db);
  const [task] = new AecEngine(db).submitGraph(project.id, [{
    id: "task-post-validation-scope",
    projectId: project.id,
    title: "Guard validation outputs",
    goal: "Create scoped.txt only",
    scope: { writeGlobs: ["scoped.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Outside output is never committed"],
    validationCommands: [{
      program: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('outside.txt','generated')"],
    }],
  }]);
  await new AecEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  assert.equal(existsSync(join(repo, "outside.txt")), false);
  assert.match(JSON.stringify(db.getLatestRunForTask(task!.id)?.error), /scope_violation/);
  db.close();
});

test("isolates one Run startup failure without terminating sibling work", async () => {
  const db = new AecDatabase(tempDir("aec-run-isolation-"));
  const brokenProject = db.createProject({ name: "broken", repoPath: join(tempDir("aec-missing-repo-"), "missing") });
  const healthyProject = db.createProject({ name: "healthy", repoPath: createGitRepository() });
  registerFakeAgents(db);
  const engine = new AecEngine(db, { globalConcurrency: 2 });
  engine.submitGraph(brokenProject.id, [{
    id: "task-broken-start",
    projectId: brokenProject.id,
    title: "Broken startup",
    goal: "Cannot inspect repo",
    scope: { writeGlobs: ["broken.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["failure is isolated"],
    priority: 10,
  }]);
  const [healthy] = engine.submitGraph(healthyProject.id, [{
    id: "task-healthy-sibling",
    projectId: healthyProject.id,
    title: "Healthy sibling",
    goal: "Create healthy.txt",
    scope: { writeGlobs: ["healthy.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["healthy task succeeds"],
  }]);
  assert.equal(await engine.runOnce(), 2);
  assert.equal(db.getTask(healthy!.id)?.status, "succeeded");
  assert.equal(db.getTask("task-broken-start")?.status, "operational_blocked");
  db.close();
});
