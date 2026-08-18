#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { AecSDatabase } from "../dist/src/db.js";
import { AecSEngine } from "../dist/src/engine.js";
import { aecSVersion } from "../dist/src/version.js";

if (process.env.AEC_S_LIVE_RUNTIME_CONFIRM !== "1") {
  throw new Error("Set AEC_S_LIVE_RUNTIME_CONFIRM=1 after confirming that local Runtime credentials may be used for this live gate");
}

const root = mkdtempSync(`${tmpdir()}/aec-s-live-runtimes-`);
const state = `${root}/state`;
const repo = `${root}/repo`;
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
git("init", "-b", "main");
git("config", "user.name", "AEC-S Live Gate");
git("config", "user.email", "aec-s-live@local");
writeFileSync(`${repo}/README.md`, "# AEC-S live runtime fixture\n");
git("add", "README.md");
git("commit", "-m", "fixture");

const scenarios = [];
const record = (id, pass) => scenarios.push({ id, status: pass ? "PASS" : "FAIL" });
let db;
try {
  db = new AecSDatabase(state);
  const project = db.createProject({
    id: "live-runtime-gate",
    name: "Live runtime gate",
    repoPath: repo,
    targetBranch: "main",
    maxConcurrency: 3,
    operationalConfig: { stabilityObservationSeconds: 0 },
  });
  const runtimes = [
    { family: "codex", adapter: "codex" },
    { family: "kimi", adapter: "kimi" },
    { family: "deepseek_harness", adapter: "deepseek_harness", config: { packageVersion: "0.1.0-rc.6" } },
  ];
  for (const runtime of runtimes) {
    db.createAgent({
      id: `${runtime.family}-executor`, name: `${runtime.family} executor`, adapter: runtime.adapter,
      runtimeFamily: runtime.family, roles: ["executor"], capabilities: [runtime.family], config: runtime.config,
    });
    db.createAgent({
      id: `${runtime.family}-reviewer`, name: `${runtime.family} reviewer`, adapter: runtime.adapter,
      runtimeFamily: runtime.family, roles: ["reviewer"], capabilities: [runtime.family], config: runtime.config,
    });
  }
  const engine = new AecSEngine(db, { globalConcurrency: 3 });
  await engine.refreshAgentAvailability();
  const probes = await engine.refreshAgentAvailability();
  const unavailable = runtimes.flatMap(({ family }) => {
    const probe = probes.get(`${family}-executor`);
    return probe?.ok ? [] : [`${family}: ${probe?.detail ?? "probe did not return a result"}`];
  });
  if (unavailable.length > 0) {
    throw new Error(`Live Runtime readiness failed:\n${unavailable.join("\n")}`);
  }
  const tasks = engine.submitGraph(project.id, runtimes.map(({ family }) => ({
    id: `live-${family}`,
    projectId: project.id,
    title: `Live ${family} lifecycle`,
    goal: `Create ${family}.txt containing exactly AEC-S-LIVE-PASS and satisfy the authoritative gate.`,
    scope: { writeGlobs: [`${family}.txt`, `${family}.first-validation`], watchGlobs: [], tags: ["live-runtime"] },
    acceptanceCriteria: ["The target contains AEC-S-LIVE-PASS"],
    requiredCapabilities: [family],
    validationCommands: [{
      program: process.execPath,
      args: ["-e", `const f=require('fs');const m='${family}.first-validation';if(!f.existsSync(m)){f.writeFileSync(m,'evidence\\n');process.exit(1)}if(f.readFileSync('${family}.txt','utf8').trim()!=='AEC-S-LIVE-PASS')process.exit(1)`],
    }],
  })));
  await engine.runUntilIdle(200);
  const runs = tasks.map((task) => db.getLatestRunForTask(task.id));
  record("LIVE-EXECUTE-THREE-RUNTIMES", tasks.every((task) => db.getTask(task.id)?.status === "succeeded"));
  record("LIVE-DETERMINISTIC-RUNTIME-ASSIGNMENT", runs.every((run, index) => run?.agentId === `${runtimes[index].family}-executor`));
  record("LIVE-REPAIR-RESUME", runs.every((run) => run && run.repairCount >= 1 && typeof run.runtimeSessionId === "string"));
  record("LIVE-REVIEW-EACH-RUNTIME", runs.every((run) => run?.review?.completed && run.review.reviewerAgentId?.startsWith(run.agentId.split("-")[0])));
  record("LIVE-AUTHORITY-BOUNDARY", runs.every((run) => run?.effects.commit?.status === "completed" && run.effects.merge?.status === "completed"));

  for (const { family } of runtimes) {
    const id = `${family}-executor`;
    db.recordAgentHealth(id, false);
    record(`LIVE-${family.toUpperCase()}-SINGLE-FAILURE-DEBOUNCED`, db.getAgent(id)?.availability === "degraded");
    db.recordAgentHealth(id, false);
    db.recordAgentHealth(id, false);
    record(`LIVE-${family.toUpperCase()}-FAILURE-THRESHOLD`, db.getAgent(id)?.availability === "unavailable");
    if (family === "codex") {
      const switchTask = engine.submitGraph(project.id, [{
        id: "live-runtime-switch",
        projectId: project.id,
        title: "Live cross-Runtime switch",
        goal: "Create runtime-switch.txt containing exactly AEC-S-LIVE-PASS.",
        scope: { writeGlobs: ["runtime-switch.txt"], watchGlobs: [], tags: ["live-runtime"] },
        acceptanceCriteria: ["Another available Runtime completes while Codex is unavailable"],
      }])[0];
      await engine.runTask(switchTask.id);
      const switchRun = db.getLatestRunForTask(switchTask.id);
      record("LIVE-CROSS-RUNTIME-SWITCH", db.getTask(switchTask.id)?.status === "succeeded" && switchRun?.agentId !== id);
    }
    db.recordAgentHealth(id, true);
    db.recordAgentHealth(id, true);
  }

  const cancelTask = engine.submitGraph(project.id, [{
    id: "live-cancel",
    projectId: project.id,
    title: "Live cancel",
    goal: "Wait for further instructions before writing cancel.txt.",
    scope: { writeGlobs: ["cancel.txt"], watchGlobs: [], tags: ["live-runtime"] },
    acceptanceCriteria: ["Cancellation is isolated"],
    requiredCapabilities: ["codex"],
  }])[0];
  const running = engine.runTask(cancelTask.id);
  for (let count = 0; count < 100 && !db.getLatestRunForTask(cancelTask.id)?.job?.pid; count += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  engine.applyDirective({ action: "cancel", taskIds: [cancelTask.id] });
  await running;
  record("LIVE-CANCEL-ISOLATED", db.getTask(cancelTask.id)?.status === "cancelled" && tasks.every((task) => db.getTask(task.id)?.status === "succeeded"));

  const observationProject = db.createProject({
    id: "live-runtime-observation",
    name: "Live Runtime observation recovery",
    repoPath: repo,
    targetBranch: "main",
    maxConcurrency: 1,
    operationalConfig: { stabilityObservationSeconds: 2 },
  });
  const observationEngine = new AecSEngine(db, { globalConcurrency: 1 });
  const observationTasks = observationEngine.submitGraph(observationProject.id, ["one", "two"].map((suffix) => ({
    id: `live-observation-${suffix}`,
    projectId: observationProject.id,
    title: `Live observation ${suffix}`,
    goal: `Create observation-${suffix}.txt containing exactly AEC-S-LIVE-PASS.`,
    scope: { writeGlobs: [`observation-${suffix}.txt`], watchGlobs: [], tags: ["live-runtime"] },
    acceptanceCriteria: ["Observation releases Runtime capacity"],
    requiredCapabilities: ["codex"],
  })));
  await observationEngine.runTask(observationTasks[0].id);
  const firstWaiting = db.getTask(observationTasks[0].id)?.status === "observing";
  await observationEngine.runTask(observationTasks[1].id);
  const secondAdmitted = db.getTask(observationTasks[1].id)?.status === "observing";
  const operationKeys = observationTasks.map((task) => db.getLatestRunForTask(task.id)?.effects.merge?.operationId);
  record("LIVE-WAIT-RELEASES-CAPACITY", firstWaiting && secondAdmitted);

  db.close();
  db = new AecSDatabase(state);
  await new Promise((done) => setTimeout(done, 2_100));
  await new AecSEngine(db, { globalConcurrency: 1 }).runUntilIdle(50);
  record("LIVE-RESTART-RECONCILES-EFFECTS", observationTasks.every((task, index) =>
    db.getTask(task.id)?.status === "succeeded" &&
    db.getLatestRunForTask(task.id)?.effects.merge?.operationId === operationKeys[index]));

  const versions = Object.fromEntries(runtimes.map(({ family }) => [
    family,
    db.getAgent(`${family}-executor`)?.runtimeVersion ?? "unknown",
  ]));
  const report = {
    schemaVersion: 1,
    aecSVersion: aecSVersion(),
    runtimeVersions: versions,
    scenarios,
    result: scenarios.every((scenario) => scenario.status === "PASS") ? "PASS" : "FAIL",
    completedAt: new Date().toISOString(),
  };
  const output = resolve(process.env.AEC_S_LIVE_REPORT ?? ".aec-s-reports/runtime-live-report.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== "PASS") process.exitCode = 1;
} finally {
  db?.close();
  rmSync(root, { recursive: true, force: true });
}
