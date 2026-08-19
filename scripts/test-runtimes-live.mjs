#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { adapterFor } from "../dist/src/adapters/agent.js";
import { AecSDatabase } from "../dist/src/db.js";
import { AecSEngine } from "../dist/src/engine.js";
import { cancelSupervisedJob } from "../dist/src/job.js";
import { redactText } from "../dist/src/redaction.js";
import { aecSVersion } from "../dist/src/version.js";

const RUNTIMES = [
  { family: "codex", adapter: "codex", capability: "fixture-typescript", reviewerFamily: "kimi" },
  { family: "kimi", adapter: "kimi", capability: "fixture-node", reviewerFamily: "deepseek_harness" },
  {
    family: "deepseek_harness",
    adapter: "deepseek_harness",
    capability: "fixture-git",
    reviewerFamily: "codex",
    config: { packageVersion: "0.1.0-rc.6" },
  },
];

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`${label} did not become observable within ${timeoutMs} ms`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

export function assertSanitizedReport(report) {
  const allowedTopLevel = new Set(["schemaVersion", "aecSVersion", "runtimeVersions", "scenarios", "result", "completedAt"]);
  for (const key of Object.keys(report)) {
    if (!allowedTopLevel.has(key)) throw new Error(`Live report contains an unsupported field: ${key}`);
  }
  const forbiddenKey = /(?:prompt|output|session|token|secret|credential|username|userName|absolutePath|workspace|home)/i;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenKey.test(key)) throw new Error(`Live report contains a forbidden field: ${key}`);
      visit(nested);
    }
  };
  visit(report);
  if (!["PASS", "FAIL"].includes(report.result)) throw new Error("Live report result must be PASS or FAIL");
  if (!Array.isArray(report.scenarios) || report.scenarios.some((scenario) =>
    typeof scenario.id !== "string" || !["PASS", "FAIL"].includes(scenario.status) || Object.keys(scenario).length !== 2)) {
    throw new Error("Live report scenarios must contain only id and PASS/FAIL status");
  }
}

function liveAdapterFactory(probeFaults) {
  return (agent) => {
    const adapter = adapterFor(agent);
    return new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "probe") {
          return async () => {
            const family = agent.runtimeFamily ?? agent.adapter;
            const remaining = probeFaults.get(family) ?? 0;
            if (remaining > 0) {
              probeFaults.set(family, remaining - 1);
              return { ok: false, detail: `AEC-S live gate injected one ${family} Adapter probe failure` };
            }
            return await target.probe();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

async function main() {
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
  const record = (id, pass) => {
    const scenario = { id, status: pass ? "PASS" : "FAIL" };
    scenarios.push(scenario);
    process.stderr.write(`[live] ${scenario.id}: ${scenario.status}\n`);
  };
  const probeFaults = new Map();
  let db;
  const stop = () => {
    if (process.exitCode === 130) return;
    process.exitCode = 130;
    for (const run of db?.listRunsWithJobs() ?? []) {
      if (run.job?.pid) cancelSupervisedJob(run.job.pid);
    }
    db?.close();
    db = undefined;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    db = new AecSDatabase(state);
    const project = db.createProject({
      id: "live-runtime-gate",
      name: "Live runtime gate",
      repoPath: repo,
      targetBranch: "main",
      maxConcurrency: 3,
      operationalConfig: { stabilityObservationSeconds: 0 },
      controlPolicy: { strictReviewMinRuntimeFamilies: 2, circuitBreaker: "enforce" },
    });
    for (const runtime of RUNTIMES) {
      db.createAgent({
        id: `${runtime.family}-executor`,
        name: `${runtime.family} executor`,
        adapter: runtime.adapter,
        runtimeFamily: runtime.family,
        roles: ["executor"],
        capabilities: [runtime.capability, "fixture-general"],
        config: runtime.config,
      });
      const reviewedCapabilities = RUNTIMES
        .filter((candidate) => candidate.reviewerFamily === runtime.family)
        .map((candidate) => candidate.capability);
      db.createAgent({
        id: `${runtime.family}-reviewer`,
        name: `${runtime.family} reviewer`,
        adapter: runtime.adapter,
        runtimeFamily: runtime.family,
        roles: ["reviewer"],
        capabilities: [...reviewedCapabilities, "fixture-general"],
        config: runtime.config,
      });
    }
    const engineOptions = { globalConcurrency: 3, adapterFactory: liveAdapterFactory(probeFaults) };
    const engine = new AecSEngine(db, engineOptions);
    await engine.refreshAgentAvailability();
    const probes = await engine.refreshAgentAvailability();
    const unavailable = RUNTIMES.flatMap(({ family }) => {
      const probe = probes.get(`${family}-executor`);
      return probe?.ok ? [] : [`${family}: ${probe?.detail ?? "probe did not return a result"}`];
    });
    if (unavailable.length > 0) throw new Error(`Live Runtime readiness failed:\n${unavailable.join("\n")}`);

    const tasks = engine.submitGraph(project.id, RUNTIMES.map(({ family, capability }) => ({
      id: `live-${family}`,
      projectId: project.id,
      title: `Live ${family} lifecycle`,
      goal: `On the initial execution Turn, make no changes and return a technical blocked result requesting Repair. When AEC-S resumes the same Session for Repair, create ${family}.txt containing exactly AEC-S-LIVE-PASS.`,
      scope: { writeGlobs: [`${family}.txt`], watchGlobs: [], tags: ["live-runtime"] },
      acceptanceCriteria: ["The target contains AEC-S-LIVE-PASS after one same-Session Repair"],
      requiredCapabilities: [capability],
      proposedRiskClass: "core",
      validationCommands: [{
        program: process.execPath,
        args: ["-e", `const f=require('fs');if(f.readFileSync('${family}.txt','utf8').trim()!=='AEC-S-LIVE-PASS')process.exit(1)`],
      }],
    })));
    await engine.runUntilIdle(200);
    const runs = tasks.map((task) => db.getLatestRunForTask(task.id));
    record("LIVE-EXECUTE-THREE-RUNTIMES", tasks.every((task) => db.getTask(task.id)?.status === "succeeded"));
    record("LIVE-DETERMINISTIC-RUNTIME-ASSIGNMENT", runs.every((run, index) => run?.agentId === `${RUNTIMES[index].family}-executor`));
    record("LIVE-REPAIR-RESUME-EACH-RUNTIME", runs.every((run) => run && run.repairCount >= 1 && typeof run.runtimeSessionId === "string"));
    record("LIVE-HETEROGENEOUS-REVIEW-MATRIX", runs.every((run, index) =>
      run?.review?.completed && run.review.reviewerAgentId === `${RUNTIMES[index].reviewerFamily}-reviewer`));
    record("LIVE-AEC-S-OWNS-COMMIT-AND-MERGE", runs.every((run) =>
      run?.effects.commit?.status === "completed" && run.effects.merge?.status === "completed") &&
      !db.listEvents(project.id).some((event) => event.type === "runtime.authority_violation"));

    for (const { family } of RUNTIMES) {
      const id = `${family}-executor`;
      probeFaults.set(family, 1);
      await engine.refreshAgentAvailability();
      record(`LIVE-${family.toUpperCase()}-SINGLE-FAILURE-DEBOUNCED`, db.getAgent(id)?.availability === "degraded");
      probeFaults.set(family, 2);
      await engine.refreshAgentAvailability();
      await engine.refreshAgentAvailability();
      record(`LIVE-${family.toUpperCase()}-FAILURE-THRESHOLD`, db.getAgent(id)?.availability === "unavailable");
      if (family === "codex") {
        const switchTask = engine.submitGraph(project.id, [{
          id: "live-runtime-switch",
          projectId: project.id,
          title: "Live cross-Runtime switch",
          goal: "Create runtime-switch.txt containing exactly AEC-S-LIVE-PASS.",
          scope: { writeGlobs: ["runtime-switch.txt"], watchGlobs: [], tags: ["live-runtime"] },
          acceptanceCriteria: ["Another available Runtime completes while Codex is unavailable"],
          requiredCapabilities: ["fixture-general"],
        }])[0];
        await engine.runTask(switchTask.id);
        const switchRun = db.getLatestRunForTask(switchTask.id);
        record("LIVE-CROSS-RUNTIME-SWITCH", db.getTask(switchTask.id)?.status === "succeeded" && switchRun?.agentId !== id);
      }
      await engine.refreshAgentAvailability();
      await engine.refreshAgentAvailability();
      record(`LIVE-${family.toUpperCase()}-RECOVERY-DEBOUNCED`, db.getAgent(id)?.availability === "available");
    }

    for (const runtime of RUNTIMES) {
      const cancelTask = engine.submitGraph(project.id, [{
        id: `live-cancel-${runtime.family}`,
        projectId: project.id,
        title: `Live ${runtime.family} cancel`,
        goal: "Inspect the fixture carefully before making any change. AEC-S will cancel this controlled Turn.",
        scope: { writeGlobs: [`cancel-${runtime.family}.txt`], watchGlobs: [], tags: ["live-runtime"] },
        acceptanceCriteria: ["Cancellation is isolated"],
        requiredCapabilities: [runtime.capability],
      }])[0];
      const running = engine.runTask(cancelTask.id, `${runtime.family}-executor`);
      await waitFor(() => Boolean(db.getLatestRunForTask(cancelTask.id)?.job?.pid), 30_000, `${runtime.family} cancel job`);
      engine.applyDirective({ action: "cancel", taskIds: [cancelTask.id] });
      await running;
      record(`LIVE-${runtime.family.toUpperCase()}-CANCEL`,
        db.getTask(cancelTask.id)?.status === "cancelled" &&
        db.listEvents(project.id).some((event) =>
          event.taskId === cancelTask.id && event.type === "runtime.cancel_requested" && event.payload.runtimeFamily === runtime.family));
    }
    record("LIVE-CANCEL-ISOLATION", tasks.every((task) => db.getTask(task.id)?.status === "succeeded"));

    for (const runtime of RUNTIMES) {
      const restartTask = engine.submitGraph(project.id, [{
        id: `live-restart-${runtime.family}`,
        projectId: project.id,
        title: `Live ${runtime.family} daemon restart`,
        goal: `Create restart-${runtime.family}.txt containing exactly AEC-S-LIVE-PASS.`,
        scope: { writeGlobs: [`restart-${runtime.family}.txt`], watchGlobs: [], tags: ["live-runtime"] },
        acceptanceCriteria: ["The same persisted Run converges after daemon restart"],
        requiredCapabilities: [runtime.capability],
        proposedRiskClass: "core",
      }])[0];
      const controller = new AbortController();
      const daemonEngine = new AecSEngine(db, { ...engineOptions, agentHealthcheckIntervalMs: 60_000 });
      const daemon = daemonEngine.daemon(controller.signal);
      await waitFor(() => Boolean(db.getLatestRunForTask(restartTask.id)?.job?.pid), 30_000, `${runtime.family} restart job`);
      const runId = db.getLatestRunForTask(restartTask.id)?.id;
      controller.abort();
      await daemon;
      const interrupted = db.getLatestRunForTask(restartTask.id);
      const released = interrupted?.id === runId && interrupted.status === "active" && !interrupted.leaseOwner && Boolean(interrupted.error?.daemonShutdown);
      await new AecSEngine(db, engineOptions).runTask(restartTask.id);
      const recovered = db.getLatestRunForTask(restartTask.id);
      record(`LIVE-${runtime.family.toUpperCase()}-DAEMON-RESTART-RECOVERY`,
        released && recovered?.id === runId && typeof recovered.runtimeSessionId === "string" && db.getTask(restartTask.id)?.status === "succeeded");
    }

    const observationRepo = `${root}/observation-repo`;
    mkdirSync(observationRepo, { recursive: true });
    const observationGit = (...args) => execFileSync("git", args, { cwd: observationRepo, stdio: "ignore" });
    observationGit("init", "-b", "main");
    observationGit("config", "user.name", "AEC-S Live Gate");
    observationGit("config", "user.email", "aec-s-live@local");
    writeFileSync(`${observationRepo}/README.md`, "# AEC-S live observation fixture\n");
    observationGit("add", "README.md");
    observationGit("commit", "-m", "fixture");
    const observationProject = db.createProject({
      id: "live-runtime-observation",
      name: "Live Runtime observation recovery",
      repoPath: observationRepo,
      targetBranch: "main",
      maxConcurrency: 1,
      operationalConfig: { stabilityObservationSeconds: 2 },
    });
    const observationEngine = new AecSEngine(db, { ...engineOptions, globalConcurrency: 1 });
    const observationTasks = observationEngine.submitGraph(observationProject.id, ["one", "two"].map((suffix) => ({
      id: `live-observation-${suffix}`,
      projectId: observationProject.id,
      title: `Live observation ${suffix}`,
      goal: `Create observation-${suffix}.txt containing exactly AEC-S-LIVE-PASS.`,
      scope: { writeGlobs: [`observation-${suffix}.txt`], watchGlobs: [], tags: ["live-runtime"] },
      acceptanceCriteria: ["Observation releases Runtime capacity"],
      requiredCapabilities: [RUNTIMES[0].capability],
    })));
    await observationEngine.runTask(observationTasks[0].id);
    const firstWaiting = db.getTask(observationTasks[0].id)?.status === "observing";
    const firstReleased = db.getAgent("codex-executor")?.currentLoad === 0 &&
      !db.listAgentLeases().some((lease) => lease.agentId === "codex-executor");
    // Reconcile health after the preceding cancel/restart fault scenarios so
    // this capacity assertion is independent of their intentional samples.
    await observationEngine.refreshAgentAvailability();
    await observationEngine.runTask(observationTasks[1].id);
    const secondAdmitted = db.getTask(observationTasks[1].id)?.status === "observing";
    const operationKeys = observationTasks.map((task) => db.getLatestRunForTask(task.id)?.effects.merge?.operationId);
    record("LIVE-WAIT-RELEASES-CAPACITY", firstWaiting && firstReleased && secondAdmitted);

    db.close();
    db = new AecSDatabase(state);
    await new Promise((done) => setTimeout(done, 2_100));
    await new AecSEngine(db, { ...engineOptions, globalConcurrency: 1 }).runUntilIdle(50);
    record("LIVE-RESTART-RECONCILES-EFFECTS", observationTasks.every((task, index) =>
      db.getTask(task.id)?.status === "succeeded" &&
      db.getLatestRunForTask(task.id)?.effects.merge?.operationId === operationKeys[index]));

    const runtimeVersions = Object.fromEntries(RUNTIMES.map(({ family }) => [
      family,
      db.getAgent(`${family}-executor`)?.runtimeVersion ?? "unknown",
    ]));
    const report = {
      schemaVersion: 2,
      aecSVersion: aecSVersion(),
      runtimeVersions,
      scenarios,
      result: scenarios.every((scenario) => scenario.status === "PASS") ? "PASS" : "FAIL",
      completedAt: new Date().toISOString(),
    };
    assertSanitizedReport(report);
    const output = resolve(process.env.AEC_S_LIVE_REPORT ?? ".aec-s-reports/runtime-live-report.json");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.result !== "PASS") process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export function formatLiveGateError(error) {
  return redactText(error instanceof Error ? error.message : String(error), 2_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${formatLiveGateError(error)}\n`);
    if (process.exitCode !== 130) process.exitCode = 1;
  });
}
