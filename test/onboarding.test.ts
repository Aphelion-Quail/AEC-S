import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatInitialization,
  formatProjectInspection,
  inspectProject,
  registerInspectedProject,
  type InitializationResult,
} from "../src/onboarding.js";
import { AecSDatabase } from "../src/db.js";
import { builtCliPath, createGitRepository, tempDir } from "./helpers.js";

function onboardingRepository(): string {
  const repo = createGitRepository();
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "guided-project",
    packageManager: "npm@11.6.0",
    engines: { node: ">=26" },
    scripts: { check: "tsc --noEmit", lint: "oxlint .", test: "node --test" },
    devDependencies: { typescript: "7.0.2" },
  }, null, 2));
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), [
    "name: CI",
    "jobs:",
    "  quality:",
    "    name: Quality Gate",
    "    runs-on: macos-latest",
    "    steps: []",
    "",
  ].join("\n"));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=AEC-S Test", "-c", "user.email=aec-s-test@local", "commit", "-m", "onboarding fixture"], {
    cwd: repo,
    stdio: "ignore",
  });
  return repo;
}

test("detects project toolchain, validation, CI, and Required Check candidates", async () => {
  const repo = onboardingRepository();
  const inspected = await inspectProject(repo);
  assert.equal(inspected.project.name, "guided-project");
  assert.equal(inspected.detected.packageManager, "npm@11.6.0");
  assert.deepEqual(inspected.detected.stack, ["node", "typescript"]);
  assert.deepEqual(inspected.detected.validationCandidates, ["check", "lint", "test"]);
  assert.deepEqual(inspected.detected.ciWorkflows, ["CI"]);
  assert.deepEqual(inspected.detected.requiredCheckCandidates, ["Quality Gate"]);
  assert.deepEqual(inspected.project.environmentContract?.components.map((component) => component.id), ["git", "node", "package-manager"]);
  assert.deepEqual(inspected.project.operationalConfig?.networkPolicy, { mode: "brokered", dependencyHosts: ["registry.npmjs.org"] });
  assert.deepEqual(inspected.detected.requiredHumanConfirmation, ["intent", "deliveryMode", "authoritativeGates"]);
});

test("prefers one aggregate validation script over redundant component scripts", async () => {
  const repo = onboardingRepository();
  const packageJson = {
    name: "guided-project",
    packageManager: "npm@11.6.0",
    engines: { node: ">=26" },
    scripts: {
      check: "tsc --noEmit",
      lint: "oxlint .",
      test: "node --test",
      validate: "npm run check && npm run test",
      "test:all": "npm run lint && npm run validate",
    },
  };
  writeFileSync(join(repo, "package.json"), JSON.stringify(packageJson, null, 2));
  const all = await inspectProject(repo);
  assert.deepEqual(all.detected.validationCandidates, ["test:all"]);
  assert.deepEqual(all.project.defaultValidation, [{ program: "npm", args: ["run", "test:all"] }]);

  delete (packageJson.scripts as Partial<typeof packageJson.scripts>)["test:all"];
  writeFileSync(join(repo, "package.json"), JSON.stringify(packageJson, null, 2));
  const validate = await inspectProject(repo);
  assert.deepEqual(validate.detected.validationCandidates, ["validate"]);
  assert.deepEqual(validate.project.defaultValidation, [{ program: "npm", args: ["run", "validate"] }]);
});

test("registers same-named repositories with stable unique IDs and deduplicates the same path", () => {
  const home = tempDir("aec-s-import-id-");
  const root = tempDir("aec-s-same-name-");
  const firstPath = join(root, "first", "same-name");
  const secondPath = join(root, "second", "same-name");
  mkdirSync(firstPath, { recursive: true });
  mkdirSync(secondPath, { recursive: true });
  const db = new AecSDatabase(home);
  const base = {
    id: "same-name",
    name: "same-name",
    targetBranch: "main",
    intent: "fixture",
  };
  const first = registerInspectedProject(db, { ...base, repoPath: firstPath });
  const duplicate = registerInspectedProject(db, { ...base, repoPath: firstPath });
  const second = registerInspectedProject(db, { ...base, repoPath: secondPath });
  assert.equal(duplicate.id, first.id);
  assert.notEqual(second.id, first.id);
  assert.match(second.id, /^same-name-[a-f0-9]{8,}$/);
  assert.equal(db.listProjects().length, 2);
  db.close();
});

test("never prints embedded Git remote credentials during project inspection", async () => {
  const repo = onboardingRepository();
  execFileSync("git", ["remote", "add", "origin", "https://user:super-secret-password@github.com/example/repository.git"], { cwd: repo });
  const inspected = await inspectProject(repo);
  assert.equal(inspected.detected.remoteUrl?.includes("super-secret-password"), false);
  assert.equal(formatProjectInspection(inspected, "en").includes("super-secret-password"), false);
});

test("detects HTTPS lockfile sources without admitting local addresses", async () => {
  const repo = onboardingRepository();
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/example": { resolved: "https://cdn.example.org/example.tgz" },
    "node_modules/local": { resolved: "https://127.0.0.1/private.tgz" },
  } }));
  const inspected = await inspectProject(repo);
  assert.deepEqual(inspected.project.operationalConfig?.networkPolicy?.dependencyHosts, ["cdn.example.org", "registry.npmjs.org"]);
});

test("renders a bilingual ready path without asking for repeated credential setup", () => {
  const initialized: InitializationResult = {
    home: "/state",
    service: "installed",
    ready: true,
    workerReady: true,
    runtimes: ["codex", "kimi", "deepseek_harness"].flatMap((family) => ["executor", "reviewer"].map((role) => ({
      id: `${family}-${role}`,
      family,
      role,
      availability: "available",
      version: "fixture/1",
      ready: true,
      probe: { ok: true, detail: "ready" },
    }))),
    nextActions: [{ id: "import_project", command: "aec-s project import /absolute/path/to/project" }],
  };
  const chinese = formatInitialization(initialized, "zh-CN");
  const english = formatInitialization(initialized, "en");
  assert.match(chinese, /Core 已就绪，无需手动配置凭据/);
  assert.match(chinese, /Kimi Code CLI/);
  assert.match(english, /no manual credential configuration is required/);
  assert.match(english, /DeepSeek Harness/);
});

test("keeps project import proposal-only until Intent and Gates are confirmed", async () => {
  const repo = onboardingRepository();
  const home = tempDir("aec-s-cli-onboarding-");
  const environment = {
    ...process.env,
    AEC_S_HOME: home,
    LC_ALL: "zh_CN.UTF-8",
    LC_MESSAGES: "zh_CN.UTF-8",
    LANG: "zh_CN.UTF-8",
  };
  const proposal = spawnSync(process.execPath, [builtCliPath(), "project", "import", repo], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(proposal.status, 0, proposal.stderr);
  assert.match(proposal.stdout, /以上内容仅为提案/);
  assert.match(proposal.stdout, /Required Check 候选: Quality Gate/);

  const rejected = spawnSync(process.execPath, [builtCliPath(), "project", "import", repo, "--apply"], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--intent/);

  const applied = spawnSync(process.execPath, [
    builtCliPath(), "project", "import", repo,
    "--apply", "--intent", "Converge the fixture", "--accept-detected-gates", "--json",
  ], { encoding: "utf8", env: environment });
  assert.equal(applied.status, 0, applied.stderr);
  const parsed = JSON.parse(applied.stdout) as { project: { intent: string } };
  assert.equal(parsed.project.intent, "Converge the fixture");
});

test("formats a concise post-import first-run path", async () => {
  const inspected = await inspectProject(onboardingRepository());
  const output = formatProjectInspection(inspected, "en", {
    ...inspected.project,
    id: "guided-project",
    intent: "Fixture intent",
    intentVersion: 1,
    environmentContract: inspected.project.environmentContract,
    operationalConfig: {
      healthFailureThreshold: 3,
      healthRecoveryThreshold: 2,
      healthProbeIntervalSeconds: 60,
      stabilityObservationSeconds: 0,
    },
    controlPolicy: {
      version: 1,
      scopeCalibration: "observe",
      temporaryRiskElevation: "observe",
      progressiveDagParking: "observe",
      autoRevert: "observe",
      circuitBreaker: "observe",
      strictReviewMinRuntimeFamilies: 1,
    },
    targetBranch: inspected.project.targetBranch ?? "main",
    remoteName: "origin",
    deliveryMode: "local",
    defaultValidation: inspected.project.defaultValidation ?? [],
    fullValidation: [],
    requiredChecks: [],
    highRiskGlobs: [],
    maxConcurrency: 3,
    createdAt: new Date().toISOString(),
  });
  assert.match(output, /Project registered/);
  assert.match(output, /aec-s doctor/);
  assert.match(output, /MCP/);
});
