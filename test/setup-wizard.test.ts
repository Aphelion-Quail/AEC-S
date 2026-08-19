import test from "node:test";
import assert from "node:assert/strict";
import { readOnboardingState } from "../src/onboarding-state.js";
import { getAecSPaths } from "../src/paths.js";
import { runSetupWizard } from "../src/setup-wizard.js";
import type { WizardChoice, WizardPrompt } from "../src/terminal-wizard.js";
import type { HostReadiness, InitializationResult } from "../src/onboarding.js";
import { createGitRepository, tempDir } from "./helpers.js";

class ScriptedPrompt implements WizardPrompt {
  output = "";
  constructor(
    private readonly selections: string[],
    private readonly confirmations: boolean[],
    private readonly inputs: string[] = [],
  ) {}

  write(text: string): void { this.output += text; }

  async select<T extends string>(_message: string, choices: Array<WizardChoice<T>>): Promise<T> {
    const value = this.selections.shift();
    const choice = choices.find((candidate) => candidate.value === value);
    if (!choice) throw new Error(`Unexpected scripted selection: ${value}`);
    return choice.value;
  }

  async confirm(): Promise<boolean> {
    const value = this.confirmations.shift();
    if (value === undefined) throw new Error("Missing scripted confirmation");
    return value;
  }

  async input(): Promise<string> {
    const value = this.inputs.shift();
    if (value === undefined) throw new Error("Missing scripted input");
    return value;
  }
}

const hostReady: HostReadiness = {
  ready: true,
  checks: [
    { id: "macos", ok: true, required: true, detail: "macOS arm64" },
    { id: "node", ok: true, required: true, detail: "v26.7.0" },
    { id: "npm", ok: true, required: true, detail: "11.6.0" },
    { id: "git", ok: true, required: true, detail: "git version 2" },
    { id: "githubCli", ok: false, required: false, detail: "not installed" },
    { id: "githubAuth", ok: false, required: false, detail: "not authenticated" },
    { id: "shell", ok: true, required: true, detail: "/bin/zsh" },
    { id: "path", ok: true, required: true, detail: "available" },
    { id: "dataDirectory", ok: true, required: true, detail: "/state" },
  ],
};

function initialization(workerReady: boolean): InitializationResult {
  return {
    home: "/state",
    service: "skipped",
    ready: true,
    workerReady,
    runtimes: ["codex", "kimi", "deepseek_harness"].flatMap((family, familyIndex) =>
      ["executor", "reviewer"].map((role) => ({
        id: `${family}-${role}`,
        family,
        role,
        availability: workerReady && familyIndex === 0 ? "available" : "unavailable",
        ready: workerReady && familyIndex === 0,
      }))),
    nextActions: [{ id: "import_project", command: "aec-s project import /absolute/path/to/project" }],
  };
}

test("runs the first-use system wizard and persists the daily-mode boundary", async () => {
  const home = tempDir("aec-s-setup-wizard-");
  const previousHome = process.env.AEC_S_HOME;
  process.env.AEC_S_HOME = home;
  try {
    const prompt = new ScriptedPrompt(
      ["zh-CN", "custom", "later"],
      [true, false],
    );
    const result = await runSetupWizard({
      prompt,
      probeHost: async () => hostReady,
      initialize: async () => initialization(false),
      now: () => "2026-08-19T00:00:00.000Z",
    });
    assert.equal(result.completed, true);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.language, "zh-CN");
    assert.equal(result.state.serviceEnabled, false);
    assert.equal(result.state.frontAgent?.kind, "custom");
    assert.match(prompt.output, /自动环境探测/);
    assert.match(prompt.output, /DeepSeek Harness\s+UNAVAILABLE/);
    assert.match(prompt.output, /不会阻塞安装/);
    assert.match(prompt.output, /AEC-S Ready/);
    assert.equal(readOnboardingState(getAecSPaths())?.status, "complete");
  } finally {
    if (previousHome === undefined) delete process.env.AEC_S_HOME;
    else process.env.AEC_S_HOME = previousHome;
  }
});

test("stops before service mutation when a required host check fails", async () => {
  const home = tempDir("aec-s-setup-host-failure-");
  const previousHome = process.env.AEC_S_HOME;
  process.env.AEC_S_HOME = home;
  let initialized = false;
  try {
    const prompt = new ScriptedPrompt(["en"], [true]);
    const result = await runSetupWizard({
      prompt,
      probeHost: async () => ({
        ready: false,
        checks: [{ id: "node", ok: false, required: true, detail: "Node 24" }],
      }),
      initialize: async () => {
        initialized = true;
        return initialization(true);
      },
    });
    assert.equal(result.completed, false);
    assert.equal(initialized, false);
    assert.equal(result.state.status, "in_progress");
    assert.match(prompt.output, /stopped before changing system services/);
  } finally {
    if (previousHome === undefined) delete process.env.AEC_S_HOME;
    else process.env.AEC_S_HOME = previousHome;
  }
});

test("self-checks Core and MCP before offering Front Agent setup", async () => {
  const home = tempDir("aec-s-setup-service-");
  const previousHome = process.env.AEC_S_HOME;
  process.env.AEC_S_HOME = home;
  let installs = 0;
  try {
    const prompt = new ScriptedPrompt(
      ["en", "workbuddy", "later"],
      [true, true],
    );
    const result = await runSetupWizard({
      prompt,
      probeHost: async () => hostReady,
      initialize: async () => initialization(true),
      installService: async () => { installs += 1; return "installed"; },
      serviceHealth: async () => ({ serviceRunning: true, mcpRunning: true, endpoint: "http://127.0.0.1:42831/mcp" }),
      configureWorkBuddy: async () => ({ kind: "workbuddy", configured: true, detail: "configured" }),
    });
    assert.equal(result.completed, true);
    assert.equal(installs, 1);
    assert.equal(result.state.mcpEndpoint, "http://127.0.0.1:42831/mcp");
    assert.match(prompt.output, /MCP Server/);
    assert.match(prompt.output, /WorkBuddy — configured/);
  } finally {
    if (previousHome === undefined) delete process.env.AEC_S_HOME;
    else process.env.AEC_S_HOME = previousHome;
  }
});

test("imports a first Project from its directory without project.json", async () => {
  const home = tempDir("aec-s-setup-project-");
  const repo = createGitRepository();
  const previousHome = process.env.AEC_S_HOME;
  process.env.AEC_S_HOME = home;
  try {
    const prompt = new ScriptedPrompt(
      ["en", "custom", "import"],
      [true, false],
      [repo, "Maintain the repository with minimal sufficient validation"],
    );
    const result = await runSetupWizard({
      prompt,
      probeHost: async () => hostReady,
      initialize: async () => initialization(true),
    });
    assert.equal(result.completed, true);
    assert.ok(result.state.projectId);
    const db = new (await import("../src/db.js")).AecSDatabase();
    try {
      const project = db.getProject(result.state.projectId!);
      assert.equal(project?.repoPath, repo);
      assert.equal(project?.intent, "Maintain the repository with minimal sufficient validation");
    } finally {
      db.close();
    }
  } finally {
    if (previousHome === undefined) delete process.env.AEC_S_HOME;
    else process.env.AEC_S_HOME = previousHome;
  }
});
