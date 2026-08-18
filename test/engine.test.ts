import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AecSDatabase } from "../src/db.js";
import { AecSEngine } from "../src/engine.js";
import { adapterFor } from "../src/adapters/agent.js";
import { createGitRepository, fixturePath, tempDir } from "./helpers.js";
import type { Run } from "../src/types.js";
import { branchHead, revertMergedTask } from "../src/git.js";

const fakeAgent = fixturePath("fake-agent.js");

test("reconciles an orphan active Run whose Task is already terminal", async () => {
  const home = tempDir("aec-s-orphan-run-");
  const db = new AecSDatabase(home);
  const project = db.createProject({ name: "orphan-run", repoPath: createGitRepository() });
  const agent = db.createAgent({ id: "orphan-executor", name: "orphan executor", adapter: "command", roles: ["executor"] });
  const task = db.createTask({
    id: "orphan-task", projectId: project.id, title: "Orphan", goal: "Converge stale state",
    scope: { writeGlobs: ["orphan.txt"], watchGlobs: [], tags: [] }, acceptanceCriteria: ["No active Run remains"],
  });
  const timestamp = new Date().toISOString();
  const run: Run = {
    id: "orphan-run", taskId: task.id, agentId: agent.id, workspaceId: "orphan-workspace",
    phase: "validate", status: "active", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base",
    validation: [], effects: {}, logDir: home, startedAt: timestamp, updatedAt: timestamp,
  };
  db.createRun(run);
  db.updateTaskStatus(task.id, "cancelled");
  const engine = new AecSEngine(db);
  assert.equal(await engine.runOnce(), 1);
  assert.equal(db.getRun(run.id)?.status, "failed");
  assert.equal(db.getRun(run.id)?.phase, "done");
  assert.equal(await engine.runOnce(), 0);
  db.close();
});

test("selects the least normalized-loaded eligible Runtime", async () => {
  const db = new AecSDatabase(tempDir("aec-s-runtime-order-"));
  const project = db.createProject({ name: "runtime-order", repoPath: createGitRepository() });
  for (const id of ["loaded-executor", "idle-executor"]) {
    db.createAgent({
      id, name: id, adapter: "command", roles: ["executor"], maxConcurrency: 2,
      config: { binary: process.execPath, execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] } },
    });
  }
  db.db.prepare("UPDATE agents SET current_load=1 WHERE id='loaded-executor'").run();
  db.createAgent({
    id: "order-reviewer", name: "order reviewer", adapter: "command", roles: ["reviewer"],
    config: { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } },
  });
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "runtime-order-task", projectId: project.id, title: "Choose idle", goal: "Create order.txt",
    scope: { writeGlobs: ["order.txt"], watchGlobs: [], tags: [] }, acceptanceCriteria: ["Idle Runtime is selected"],
  }]);
  await engine.runTask(task!.id);
  assert.equal(db.getLatestRunForTask(task!.id)?.agentId, "idle-executor");
  db.close();
});

test("direct Run admission preserves Scope conflicts across recovery paths", async () => {
  const home = tempDir("aec-s-direct-admission-");
  const db = new AecSDatabase(home);
  const project = db.createProject({ name: "direct-admission", repoPath: createGitRepository(), maxConcurrency: 2 });
  const agent = db.createAgent({ id: "admission-executor", name: "admission executor", adapter: "command", roles: ["executor"] });
  const first = db.createTask({
    id: "admission-first", projectId: project.id, title: "First", goal: "Own shared scope",
    scope: { writeGlobs: ["shared/**"], watchGlobs: [], tags: [] }, acceptanceCriteria: ["Scope reserved"],
  });
  const second = db.createTask({
    id: "admission-second", projectId: project.id, title: "Second", goal: "Wait for shared scope",
    scope: { writeGlobs: ["shared/file.ts"], watchGlobs: [], tags: [] }, acceptanceCriteria: ["No overlap"],
  });
  db.updateTaskStatus(first.id, "running");
  db.updateTaskStatus(second.id, "ready");
  const timestamp = new Date().toISOString();
  db.createRun({
    id: "admission-active-run", taskId: first.id, agentId: agent.id, workspaceId: "admission-active-workspace",
    phase: "execute", status: "active", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base",
    validation: [], effects: {}, logDir: home, startedAt: timestamp, updatedAt: timestamp,
    leaseOwner: "999999:other", leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const engine = new AecSEngine(db, { globalConcurrency: 2 });
  await engine.runTask(second.id);
  assert.equal(db.getLatestRunForTask(second.id), undefined);

  db.createRun({
    id: "admission-interrupted-run", taskId: second.id, agentId: agent.id, workspaceId: "admission-interrupted-workspace",
    phase: "execute", status: "interrupted", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base",
    validation: [], effects: {}, logDir: home, startedAt: timestamp, updatedAt: timestamp,
  });
  await engine.runTask(second.id);
  assert.equal(db.getRun("admission-interrupted-run")?.status, "interrupted");
  db.close();
});

function registerFakeAgents(db: AecSDatabase, executeMode = "execute", reviewMode = "review"): void {
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
  const db = new AecSDatabase(home);
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
  const engine = new AecSEngine(db, { globalConcurrency: input.globalConcurrency });
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

test("schedules Codex, Kimi, and DeepSeek Harness concurrently through protocol substitutes", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-s-three-runtime-scheduler-");
  const timeline = join(home, "three-runtime-timeline.txt");
  const db = new AecSDatabase(home);
  const project = db.createProject({ name: "three-runtime-scheduler", repoPath: repo, maxConcurrency: 3 });
  const runtimes = ["codex", "kimi", "deepseek_harness"] as const;
  for (const runtime of runtimes) {
    const runtimeCapabilities = { resume: true, cancel: true, stream: true, reviewMode: true, structuredOutput: true };
    db.createAgent({
      id: `${runtime}-executor`,
      name: `${runtime} executor substitute`,
      adapter: runtime,
      runtimeFamily: runtime,
      roles: ["executor"],
      capabilities: [runtime],
      runtimeCapabilities,
    });
    db.createAgent({
      id: `${runtime}-reviewer`,
      name: `${runtime} reviewer substitute`,
      adapter: runtime,
      runtimeFamily: runtime,
      roles: ["reviewer"],
      capabilities: [runtime],
      runtimeCapabilities,
    });
  }
  const engine = new AecSEngine(db, {
    globalConcurrency: 3,
    adapterFactory: (runtimeAgent) => adapterFor({
      ...runtimeAgent,
      adapter: "command",
      config: runtimeAgent.roles.includes("reviewer")
        ? { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } }
        : {
            binary: process.execPath,
            execute: { program: process.execPath, args: [fakeAgent, "timeline-triple-barrier", "{workspace}", "{output}", timeline] },
            repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
          },
    }),
  });
  const tasks = engine.submitGraph(project.id, runtimes.map((runtime) => ({
    id: `three-runtime-${runtime}`,
    projectId: project.id,
    title: `Schedule ${runtime}`,
    goal: `Create ${runtime}.txt`,
    scope: { writeGlobs: [`${runtime}.txt`], watchGlobs: [], tags: ["three-runtime"] },
    acceptanceCriteria: [`${runtime} protocol substitute completes`],
    requiredCapabilities: [runtime],
  })));
  await engine.runUntilIdle();
  assert.equal(tasks.every((task) => db.getTask(task.id)?.status === "succeeded"), true);
  assert.deepEqual(new Set(tasks.map((task) => db.getLatestRunForTask(task.id)?.agentId)), new Set(runtimes.map((runtime) => `${runtime}-executor`)));
  const starts = readFileSync(timeline, "utf8").trim().split(/\r?\n/).filter((entry) => entry.endsWith(":start"));
  assert.equal(new Set(starts).size, 3);
  db.close();
});

test("runs two independent tasks without invalidating the second on HEAD change", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-s-home-");
  const db = new AecSDatabase(home);
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
      execute: { program: process.execPath, args: [fakeAgent, "timeline-barrier", "{workspace}", "{output}", executionTimeline] },
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
  const engine = new AecSEngine(db, { globalConcurrency: 2 });
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
  assert.match(log, /AEC-S-Task: task-ui/);
  assert.match(log, /AEC-S-Task: task-core/);
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
  const home = tempDir("aec-s-related-head-");
  const validationCount = join(home, "validation-count.txt");
  const db = new AecSDatabase(home);
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
  const engine = new AecSEngine(db);
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
  for (let index = 0; index < 1_200 && !db.getLatestRunForTask(task!.id)?.job; index += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.ok(db.getLatestRunForTask(task!.id)?.job, "the Agent job must be running before target HEAD changes");
  writeFileSync(join(repo, "shared.txt"), "related target change\n");
  execFileSync("git", ["add", "shared.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC-S Test", "-c", "user.email=aec-s-test@local", "commit", "-m", "related change"], {
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
  const db = new AecSDatabase(tempDir("aec-s-lease-heartbeat-"));
  const project = db.createProject({ name: "lease-heartbeat", repoPath: createGitRepository() });
  registerFakeAgents(db, "slow");
  const originalRenew = db.renewRunLease.bind(db);
  let renewals = 0;
  db.renewRunLease = (...args) => {
    renewals += 1;
    return originalRenew(...args);
  };
  const engine = new AecSEngine(db, { leaseHeartbeatMs: 20 });
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
  const db = new AecSDatabase(tempDir("aec-s-priority-audit-"));
  const project = db.createProject({ name: "priority-audit", repoPath: createGitRepository() });
  const engine = new AecSEngine(db);
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
  const db = new AecSDatabase(tempDir("aec-s-home-"));
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
  const engine = new AecSEngine(db);
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
  for (let index = 0; index < 1_200 && !db.getLatestRunForTask(pausedTask!.id)?.job; index += 1) {
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
  const db = new AecSDatabase(tempDir("aec-s-tracked-"));
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-tracked",
    projectId: project.id,
    title: "Update tracked file",
    goal: "Update README.md",
    scope: { writeGlobs: ["README.md"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["README changes"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.match(readFileSync(join(repo, "README.md"), "utf8"), /task-tracked/);
  db.close();
});

test("records failed authoritative validation and repairs it", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-validation-repair-"));
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
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
  await new AecSEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.repairCount, 1);
  assert.equal(run.validation.at(-1)?.status, "passed");
  assert.equal(readFileSync(join(repo, "repaired.txt"), "utf8"), "repaired\n");
  db.close();
});

test("records timed-out authoritative validation and repairs it", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-validation-timeout-"));
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-validation-timeout",
    projectId: project.id,
    title: "Repair timed-out validation",
    goal: "Produce repaired content",
    scope: { writeGlobs: ["repaired.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Validation passes after repair"],
    validationCommands: [{
      program: "/bin/sh",
      args: ["-c", "grep -q repaired repaired.txt || while :; do sleep 1; done"],
      timeoutSeconds: 1,
    }],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.repairCount, 1);
  assert.equal(run.validation.at(-1)?.status, "passed");
  db.close();
});

test("treats a validation spawn error as operational instead of asking the Agent to repair code", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-validation-spawn-error-"));
  const project = db.createProject({ name: "validation-spawn-error", repoPath: repo });
  registerFakeAgents(db);
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-validation-spawn-error",
    projectId: project.id,
    title: "Classify validator startup failure",
    goal: "Create spawn-error.txt",
    scope: { writeGlobs: ["spawn-error.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Infrastructure failure does not trigger code repair"],
    validationCommands: [{ program: "/definitely/missing/aec-s-validator", args: [] }],
  }]);
  await new AecSEngine(db, { operationalRetryBaseMs: 60_000 }).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.equal(run.status, "interrupted");
  assert.equal(run.repairCount, 0);
  assert.match(JSON.stringify(run.error), /operationalRetry/);
  assert.match(JSON.stringify(run.error), /validation could not start/);
  db.close();
});

test("repairs a blocking independent Review finding and reviews the new diff", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-review-repair-"));
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-review-repair",
    projectId: project.id,
    title: "Repair review finding",
    goal: "Produce reviewed content",
    scope: { writeGlobs: ["reviewed.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Review passes after repair"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.repairCount, 1);
  assert.equal(run.review?.verdict, "pass");
  assert.equal(readFileSync(join(repo, "reviewed.txt"), "utf8"), "repaired\n");
  db.close();
});

test("rotates to a second eligible executor after repair attempts are exhausted", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-agent-rotation-"));
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-agent-rotation",
    projectId: project.id,
    title: "Rotate executor",
    goal: "Complete with the alternate executor",
    scope: { writeGlobs: ["rotated.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Alternate executor succeeds"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.rotationCount, 1);
  assert.equal(run.agentId, "b-working");
  db.close();
});

test("debounces Runtime failure before switching from Codex to Kimi", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-cross-runtime-switch-"));
  const project = db.createProject({ name: "cross-runtime-switch", repoPath: repo });
  const runtimeCapabilities = { resume: true, cancel: true, stream: true, reviewMode: true, structuredOutput: true };
  db.createAgent({
    id: "a-codex-executor",
    name: "Codex executor substitute",
    adapter: "codex",
    runtimeFamily: "codex",
    roles: ["executor"],
    runtimeCapabilities,
  });
  db.createAgent({
    id: "b-kimi-executor",
    name: "Kimi executor substitute",
    adapter: "kimi",
    runtimeFamily: "kimi",
    roles: ["executor"],
    runtimeCapabilities,
  });
  db.createAgent({
    id: "c-dsh-reviewer",
    name: "DSH reviewer substitute",
    adapter: "deepseek_harness",
    runtimeFamily: "deepseek_harness",
    roles: ["reviewer"],
    runtimeCapabilities,
  });
  const engine = new AecSEngine(db, {
    adapterFactory: (runtimeAgent) => adapterFor({
      ...runtimeAgent,
      adapter: "command",
      config: runtimeAgent.id === "a-codex-executor"
        ? {
            binary: process.execPath,
            execute: { program: process.execPath, args: [fakeAgent, "malformed-result", "{workspace}", "{output}"] },
          }
        : runtimeAgent.roles.includes("reviewer")
          ? { binary: process.execPath, review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] } }
          : {
              binary: process.execPath,
              execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
              repair: { program: process.execPath, args: [fakeAgent, "repair", "{workspace}", "{output}"] },
            },
    }),
  });
  const [task] = engine.submitGraph(project.id, [{
    id: "task-cross-runtime-switch",
    projectId: project.id,
    title: "Switch only after debounced failure",
    goal: "Create switched.txt",
    scope: { writeGlobs: ["switched.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Kimi completes after Codex reaches its failure threshold"],
  }]);
  await engine.runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(run.agentId, "b-kimi-executor");
  assert.equal(run.rotationCount, 1);
  assert.equal(run.metrics?.runtimeSwitches, 1);
  assert.equal(db.getAgent("a-codex-executor")?.availability, "unavailable");
  assert.equal(db.listEvents(project.id).some((event) =>
    event.type === "run.agent_rotated" && event.payload.fromRuntimeFamily === "codex" && event.payload.runtimeFamily === "kimi"), true);
  db.close();
});

test("does not bypass the independent Review Gate when no reviewer is available", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-review-gate-"));
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-review-required",
    projectId: project.id,
    title: "Require review",
    goal: "Create review-required.txt",
    scope: { writeGlobs: ["review-required.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Independent review is required"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.match(String(db.getLatestRunForTask(task!.id)?.error?.message), /No independent reviewer/);
  assert.equal(existsSync(join(repo, "review-required.txt")), false);
  db.close();
});

test("runs configured full validation for a high-risk Task path", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-s-high-risk-");
  const fullMarker = join(home, "full-validation-ran.txt");
  const db = new AecSDatabase(home);
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
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-high-risk",
    projectId: project.id,
    title: "Change critical path",
    goal: "Create critical/state.txt",
    scope: { writeGlobs: ["critical/state.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Critical change is fully validated"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(readFileSync(fullMarker, "utf8"), "yes");
  db.close();
});

test("recalculates the Risk Floor after validation generates a high-risk file", async () => {
  const repo = createGitRepository();
  const home = tempDir("aec-s-post-validation-risk-");
  const fullMarker = join(home, "full-validation-ran.txt");
  const db = new AecSDatabase(home);
  const project = db.createProject({
    name: "post-validation-risk",
    repoPath: repo,
    highRiskGlobs: ["critical/**"],
    defaultValidation: [{
      program: process.execPath,
      args: ["-e", "require('node:fs').mkdirSync('critical',{recursive:true});require('node:fs').writeFileSync('critical/generated.txt','generated')"],
    }],
    fullValidation: [{
      program: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(fullMarker)},'ran')`],
    }],
  });
  registerFakeAgents(db);
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-post-validation-risk",
    projectId: project.id,
    title: "Generated risk",
    goal: "Generate a registered high-risk artifact",
    scope: { writeGlobs: ["feature.txt", "critical/**"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Risk is recalculated after validation"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(db.getTaskRevision(db.getTask(task!.id)!.currentRevisionId!)?.effectiveRiskClass, "core");
  assert.equal(readFileSync(fullMarker, "utf8"), "ran");
  assert.ok((db.getLatestRunForTask(task!.id)?.metrics?.validationRuns ?? 0) >= 2);
  db.close();
});

test("verifies required Environment Contract commands before Runtime execution", async () => {
  const db = new AecSDatabase(tempDir("aec-s-environment-contract-"));
  const project = db.createProject({
    name: "environment-contract",
    repoPath: createGitRepository(),
    environmentContract: {
      version: 1,
      components: [{
        id: "toolchain",
        version: "2.0.0",
        command: { program: process.execPath, args: ["-e", "process.stdout.write('1.0.0')"] },
      }],
    },
  });
  registerFakeAgents(db);
  const engine = new AecSEngine(db, { operationalRetryBaseMs: 1 });
  const [task] = engine.submitGraph(project.id, [{
    id: "task-environment-contract",
    projectId: project.id,
    title: "Require toolchain",
    goal: "Do not execute under the wrong environment",
    scope: { writeGlobs: ["environment.txt"], watchGlobs: [], tags: [] },
    environmentRequirements: ["toolchain"],
    acceptanceCriteria: ["Environment is verified"],
  }]);
  await engine.runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.match(db.getTask(task!.id)?.terminalSummary ?? "", /version mismatch/);
  assert.equal(db.getLatestRunForTask(task!.id)?.phase, "prepare");
  db.close();
});

test("keeps Scope Calibration observational until a Human approves the Revision", async () => {
  const db = new AecSDatabase(tempDir("aec-s-scope-calibration-"));
  const project = db.createProject({ name: "scope-calibration", repoPath: createGitRepository() });
  registerFakeAgents(db, "scope-expansion");
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-scope-calibration",
    projectId: project.id,
    title: "Observe scope",
    goal: "Request one bounded expansion",
    scope: { writeGlobs: ["initial.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Human approves the new Revision"],
  }]);
  await engine.runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  const decision = db.listDecisions(project.id, "pending").find((candidate) => candidate.kind === "policy")!;
  engine.resolveDecision(decision.id, { action: "approve_scope" });
  assert.equal(db.getTask(task!.id)?.status, "ready");
  assert.ok(db.getTask(task!.id)?.scope.writeGlobs.includes("approved.txt"));
  db.close();
});

test("promotes DAG dependants only after their dependencies merge", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-dag-") );
  const project = db.createProject({ name: "dag", repoPath: repo });
  registerFakeAgents(db);
  const [first, second] = new AecSEngine(db).submitGraph(project.id, [
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
  const engine = new AecSEngine(db);
  await engine.runUntilIdle();
  assert.equal(db.getTask(first!.id)?.status, "succeeded");
  assert.equal(db.getTask(second!.id)?.status, "succeeded");
  assert.ok(db.getTask(first!.id)!.updatedAt <= db.getLatestRunForTask(second!.id)!.startedAt);
  db.close();
});

test("provides authoritative validation evidence to the independent reviewer", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-review-evidence-"));
  const project = db.createProject({
    name: "review-evidence",
    repoPath: repo,
    defaultValidation: [{ program: process.execPath, args: ["-e", "process.exit(0)"] }],
  });
  registerFakeAgents(db, "execute", "review-validation");
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-review-evidence",
    projectId: project.id,
    title: "Review evidence",
    goal: "Create evidence.txt",
    scope: { writeGlobs: ["evidence.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Reviewer receives evidence"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(db.getLatestRunForTask(task!.id)?.review?.summary, "Validation evidence received");
  db.close();
});

test("switches to another eligible Reviewer only after the retained Reviewer reaches its failure threshold", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-reviewer-failover-"));
  const project = db.createProject({ name: "reviewer-failover", repoPath: repo });
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
    id: "a-failing-reviewer",
    name: "failing reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review-malformed", "{workspace}", "{output}"] },
    },
  });
  db.createAgent({
    id: "b-working-reviewer",
    name: "working reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecSEngine(db, { operationalRetryBaseMs: 1 });
  const [task] = engine.submitGraph(project.id, [{
    id: "task-reviewer-failover",
    projectId: project.id,
    title: "Fail over Review safely",
    goal: "Create reviewer-failover.txt",
    scope: { writeGlobs: ["reviewer-failover.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["A second Reviewer completes only after the first is unavailable"],
  }]);

  await engine.runTask(task!.id);
  if (db.getTask(task!.id)?.status !== "succeeded") {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.runUntilIdle();
  }
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(db.getAgent("a-failing-reviewer")?.availability, "unavailable");
  assert.equal(run.review?.reviewerAgentId, "b-working-reviewer");
  assert.equal(run.attempt, 1);
  assert.equal(run.metrics?.runtimeSwitches, 1);
  assert.equal(db.listEvents(project.id).some((event) =>
    event.type === "run.reviewer_rotated" &&
    event.payload.fromAgentId === "a-failing-reviewer" &&
    event.payload.agentId === "b-working-reviewer"), true);
  db.close();
});

test("blocks a Reviewer adapter that mutates the task workspace", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-mutating-reviewer-"));
  const project = db.createProject({ name: "mutating-reviewer", repoPath: repo });
  registerFakeAgents(db, "execute", "review-mutate");
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-mutating-reviewer",
    projectId: project.id,
    title: "Reject mutating reviewer",
    goal: "Create safe.txt",
    scope: { writeGlobs: ["safe.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Reviewer remains read-only"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.match(db.getTask(task!.id)?.terminalSummary ?? "", /modified the task workspace/);
  assert.equal(existsSync(join(repo, "reviewer-leak.txt")), false);
  db.close();
});

test("does not advance a Task when Runtime output violates the AEC-S Schema", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-malformed-runtime-output-"));
  const project = db.createProject({ name: "malformed-runtime-output", repoPath: repo });
  registerFakeAgents(db, "malformed-result");
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-malformed-runtime-output",
    projectId: project.id,
    title: "Reject malformed Runtime output",
    goal: "Never accept incomplete structured output",
    scope: { writeGlobs: ["malformed.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Malformed output cannot advance engineering state"],
  }]);
  await new AecSEngine(db, { operationalRetryBaseMs: 60_000 }).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  assert.equal(run.phase, "execute");
  assert.equal(run.workerResult, undefined);
  assert.equal(run.effects.commit, undefined);
  assert.equal(existsSync(join(repo, "malformed.txt")), false);
  assert.match(String(run.error?.message ?? ""), /invalid structured result|output Schema/);
  db.close();
});

test("rejects a Runtime that attempts to take Git commit authority", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-runtime-commit-authority-"));
  const project = db.createProject({ name: "runtime-commit-authority", repoPath: repo });
  registerFakeAgents(db, "commit-authority-violation");
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-runtime-commit-authority",
    projectId: project.id,
    title: "Keep commit authority in AEC-S",
    goal: "The Runtime may edit but may not commit",
    scope: { writeGlobs: ["authority.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Runtime commit is detected before validation"],
  }]);
  await new AecSEngine(db, { operationalRetryBaseMs: 60_000 }).runTask(task!.id);
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  assert.equal(run.phase, "execute");
  assert.equal(run.workerResult, undefined);
  assert.equal(run.effects.commit, undefined);
  assert.equal(existsSync(join(repo, "authority.txt")), false);
  assert.match(String(run.error?.message ?? ""), /Runtime authority violation/);
  assert.equal(db.getAgent(run.agentId)?.availability, "unavailable");
  assert.equal(db.listEvents(project.id).some((event) => event.type === "runtime.authority_violation"), true);
  assert.equal(db.listDecisions(project.id, "pending").length, 1);
  db.close();
});

test("keeps cancellation terminal when a supervised validation job is interrupted", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-cancel-validation-"));
  const project = db.createProject({ name: "cancel-validation", repoPath: repo });
  registerFakeAgents(db);
  const engine = new AecSEngine(db);
  const [task] = engine.submitGraph(project.id, [{
    id: "task-cancel-validation",
    projectId: project.id,
    title: "Cancel validation",
    goal: "Create cancel-validation.txt",
    scope: { writeGlobs: ["cancel-validation.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Cancellation remains terminal"],
    validationCommands: [{ program: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeoutSeconds: 60 }],
  }]);
  const running = engine.runTask(task!.id);
  for (let count = 0; count < 200; count += 1) {
    const run = db.getLatestRunForTask(task!.id);
    if (run?.phase === "validate" && run.job?.pid) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(db.getLatestRunForTask(task!.id)?.phase, "validate");
  engine.applyDirective({ action: "cancel", taskIds: [task!.id] });
  await running;
  const run = db.getLatestRunForTask(task!.id)!;
  assert.equal(db.getTask(task!.id)?.status, "cancelled");
  assert.equal(run.status, "failed");
  assert.equal(run.error?.operationalRetry, undefined);
  assert.equal(existsSync(join(repo, "cancel-validation.txt")), false);
  db.close();
});

test("does not publish a failed Review that provides no blocking Finding", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-empty-failed-review-"));
  const project = db.createProject({ name: "empty-failed-review", repoPath: repo });
  registerFakeAgents(db, "execute", "review-empty-fail");
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-empty-failed-review",
    projectId: project.id,
    title: "Reject empty failed Review",
    goal: "Create empty-failed-review.txt",
    scope: { writeGlobs: ["empty-failed-review.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["A failed verdict must be actionable"],
  }]);
  await new AecSEngine(db, { operationalRetryBaseMs: 60_000 }).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.equal(db.getLatestRunForTask(task!.id)?.effects.commit?.status, "completed");
  assert.equal(db.getLatestRunForTask(task!.id)?.effects.push, undefined);
  assert.equal(db.getLatestRunForTask(task!.id)?.effects.pullRequest, undefined);
  assert.equal(existsSync(join(repo, "empty-failed-review.txt")), false);
  assert.match(String(db.getLatestRunForTask(task!.id)?.error?.message), /blocking Finding/);
  db.close();
});

test("refuses to commit out-of-scope files created by authoritative validation", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-post-validation-scope-"));
  const project = db.createProject({ name: "post-validation-scope", repoPath: repo });
  registerFakeAgents(db);
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
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
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  assert.equal(existsSync(join(repo, "outside.txt")), false);
  assert.match(JSON.stringify(db.getLatestRunForTask(task!.id)?.error), /scope_violation/);
  db.close();
});

test("isolates one Run startup failure without terminating sibling work", async () => {
  const db = new AecSDatabase(tempDir("aec-s-run-isolation-"));
  const brokenProject = db.createProject({ name: "broken", repoPath: join(tempDir("aec-s-missing-repo-"), "missing") });
  const healthyProject = db.createProject({ name: "healthy", repoPath: createGitRepository() });
  registerFakeAgents(db);
  const engine = new AecSEngine(db, { globalConcurrency: 2 });
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
  assert.match(JSON.stringify(db.getLatestRunForTask("task-broken-start")?.error), /operationalRetry/);
  db.close();
});

test("automatically retries an operationally blocked Run after the dependency recovers", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-operational-retry-"));
  const project = db.createProject({ name: "operational-retry", repoPath: repo });
  db.createAgent({
    id: "retry-executor",
    name: "retry executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecSEngine(db, { operationalRetryBaseMs: 1 });
  const [task] = engine.submitGraph(project.id, [{
    id: "task-operational-retry",
    projectId: project.id,
    title: "Recover missing reviewer",
    goal: "Create retry.txt",
    scope: { writeGlobs: ["retry.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Task resumes without a Human directive"],
  }]);
  await engine.runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "operational_blocked");
  assert.equal(db.getLatestRunForTask(task!.id)?.status, "interrupted");
  db.createAgent({
    id: "retry-reviewer",
    name: "retry reviewer",
    adapter: "command",
    roles: ["reviewer"],
    config: {
      binary: process.execPath,
      review: { program: process.execPath, args: [fakeAgent, "review", "{workspace}", "{output}"] },
    },
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  await engine.runUntilIdle();
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(db.listRuns(task!.id).length, 1);
  assert.ok(db.listEvents(project.id).some((event) => event.type === "run.retry_ready"));
  db.close();
});

test("escalates only after persisted operational retries are exhausted", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-operational-exhaustion-"));
  const project = db.createProject({ name: "operational-exhaustion", repoPath: repo });
  db.createAgent({
    id: "exhaustion-executor",
    name: "exhaustion executor",
    adapter: "command",
    roles: ["executor"],
    config: {
      binary: process.execPath,
      execute: { program: process.execPath, args: [fakeAgent, "execute", "{workspace}", "{output}"] },
    },
  });
  const engine = new AecSEngine(db, { operationalRetryBaseMs: 1, maxOperationalRetries: 1 });
  const [task] = engine.submitGraph(project.id, [{
    id: "task-operational-exhaustion",
    projectId: project.id,
    title: "Exhaust missing reviewer retries",
    goal: "Create exhausted.txt",
    scope: { writeGlobs: ["exhausted.txt"], impactGlobs: [], tags: [] },
    acceptanceCriteria: ["Escalation is bounded"],
  }]);
  await engine.runTask(task!.id);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  await engine.runUntilIdle();
  assert.equal(db.getTask(task!.id)?.status, "awaiting_human");
  assert.equal(db.listDecisions(project.id, "pending").at(-1)?.kind, "failure_exhausted");
  db.close();
});

test("reconciles enabled Agent health while preserving explicit offline state", async () => {
  const db = new AecSDatabase(tempDir("aec-s-agent-health-"));
  db.createAgent({
    id: "health-agent",
    name: "health agent",
    adapter: "command",
    roles: ["executor"],
    config: { binary: "/definitely/missing/aec-s-agent" },
  });
  db.createAgent({
    id: "manual-offline-agent",
    name: "manual offline agent",
    adapter: "command",
    roles: ["executor"],
    availability: "offline",
    config: { binary: process.execPath },
  });
  const engine = new AecSEngine(db);
  await engine.refreshAgentAvailability();
  assert.equal(db.getAgent("health-agent")?.availability, "degraded");
  assert.equal(db.getAgent("manual-offline-agent")?.availability, "offline");
  db.updateAgent("health-agent", { config: { binary: process.execPath } });
  await engine.refreshAgentAvailability();
  assert.equal(db.getAgent("health-agent")?.availability, "healthy");
  await engine.refreshAgentAvailability();
  assert.equal(db.getAgent("health-agent")?.availability, "available");
  db.close();
});

test("releases Runtime capacity during the post-merge observation window", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-observation-capacity-"));
  const project = db.createProject({
    name: "observation-capacity",
    repoPath: repo,
    operationalConfig: { stabilityObservationSeconds: 1 },
  });
  registerFakeAgents(db);
  const engine = new AecSEngine(db, { globalConcurrency: 1 });
  const [observed] = engine.submitGraph(project.id, [{
    id: "task-observed",
    projectId: project.id,
    title: "Observe merged work",
    goal: "Create observed.txt",
    scope: { writeGlobs: ["observed.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Observation releases capacity"],
  }]);
  await engine.runTask(observed!.id);
  assert.equal(db.getTask(observed!.id)?.status, "observing");
  assert.equal(db.getLatestRunForTask(observed!.id)?.status, "interrupted");
  assert.equal(db.getAgent("executor")?.currentLoad, 0);

  const [next] = engine.submitGraph(project.id, [{
    id: "task-during-observation",
    projectId: project.id,
    title: "Use released capacity",
    goal: "Create next-observed.txt",
    scope: { writeGlobs: ["next-observed.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Runs while another Task observes"],
  }]);
  await engine.runTask(next!.id);
  assert.equal(db.getTask(next!.id)?.status, "observing");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
  await engine.runUntilIdle();
  assert.equal(db.getTask(observed!.id)?.status, "succeeded");
  assert.equal(db.getTask(next!.id)?.status, "succeeded");
  db.close();
});

test("parks a failed post-merge smoke and creates a bounded Repair Task", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-post-merge-smoke-"));
  const project = db.createProject({
    name: "post-merge-smoke",
    repoPath: repo,
    postMergeSmoke: [{ program: process.execPath, args: ["-e", "process.exit(1)"] }],
  });
  registerFakeAgents(db);
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-smoke-failure",
    projectId: project.id,
    title: "Fail smoke safely",
    goal: "Create smoke-failure.txt",
    scope: { writeGlobs: ["smoke-failure.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Failure does not claim convergence"],
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "parked");
  assert.equal(db.getTask(task!.id)?.mergeSha !== undefined, true);
  const repair = db.listTasks(project.id).find((candidate) => candidate.id.startsWith("repair-task-smoke-failure-"));
  assert.equal(repair?.status, "parked");
  assert.equal(repair?.proposedRiskClass, "core");
  const decision = db.listDecisions(project.id, "pending").find((candidate) => candidate.taskId === repair?.id);
  assert.equal(decision?.kind, "failure_exhausted");
  assert.equal(db.listOutbox(project.id).filter((message) => message.decisionId === decision?.id).length, 2);
  assert.ok(db.listEvents(project.id).some((event) => event.type === "revert.parked"));
  db.updateTaskStatus(repair!.id, "succeeded", { mergeSha: await branchHead(repo, "main") });
  await new AecSEngine(db).runOnce();
  assert.equal(db.getTask(task!.id)?.status, "succeeded");
  assert.equal(db.getLatestRunForTask(task!.id)?.status, "completed");
  assert.ok(db.listEvents(project.id).some((event) => event.type === "post_merge_repair.resolved"));
  db.close();
});

test("auto-reverts only an explicitly safe local merge under enforce policy", async () => {
  const repo = createGitRepository();
  const db = new AecSDatabase(tempDir("aec-s-auto-revert-"));
  const project = db.createProject({
    name: "auto-revert",
    repoPath: repo,
    postMergeSmoke: [{ program: process.execPath, args: ["-e", "process.exit(1)"] }],
    controlPolicy: { autoRevert: "enforce" },
  });
  registerFakeAgents(db);
  const [task] = new AecSEngine(db).submitGraph(project.id, [{
    id: "task-auto-revert",
    projectId: project.id,
    title: "Revert safe merge",
    goal: "Create auto-revert.txt",
    scope: { writeGlobs: ["auto-revert.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Unsafe mainline state is removed"],
    revertSafe: true,
  }]);
  await new AecSEngine(db).runTask(task!.id);
  assert.equal(db.getTask(task!.id)?.status, "parked");
  assert.equal(existsSync(join(repo, "auto-revert.txt")), false);
  assert.equal(db.getLatestRunForTask(task!.id)?.effects.revert?.status, "completed");
  const run = db.getLatestRunForTask(task!.id)!;
  const currentHead = await branchHead(repo, "main");
  assert.equal(await revertMergedTask(project, run.effects.merge!.externalRef!, task!.id), currentHead);
  assert.ok(db.listEvents(project.id).some((event) => event.type === "revert.completed"));
  db.close();
});
