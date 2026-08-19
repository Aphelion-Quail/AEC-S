import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AecSDatabase } from "./db.js";
import { execCommand } from "./exec.js";
import { fingerprint } from "./fingerprint.js";
import { projectInputSchema } from "./input.js";
import { mcpHttpPort } from "./mcp.js";
import {
  formatProjectInspection,
  initializeAecS,
  inspectProject,
  probeHostReadiness,
  type HostReadiness,
  type InitializationResult,
  type OnboardingLanguage,
  type ProjectInspection,
} from "./onboarding.js";
import {
  readOnboardingState,
  writeOnboardingState,
  type FrontAgentConfiguration,
  type OnboardingState,
} from "./onboarding-state.js";
import { getAecSPaths, type AecSPaths } from "./paths.js";
import { discoverExecutable } from "./runtime-discovery.js";
import { serviceAction } from "./service.js";
import { TerminalWizardPrompt, type WizardPrompt } from "./terminal-wizard.js";
import type { Agent, Project } from "./types.js";

export type ServiceHealth = {
  serviceRunning: boolean;
  mcpRunning: boolean;
  endpoint: string;
};

export type SetupWizardResult = {
  completed: boolean;
  state: OnboardingState;
};

type SetupWizardDependencies = {
  prompt: WizardPrompt;
  initialize: (options: { installService?: boolean }) => Promise<InitializationResult>;
  probeHost: () => Promise<HostReadiness>;
  inspectProject: (path: string) => Promise<ProjectInspection>;
  installService: (paths: AecSPaths) => Promise<string>;
  restartService: (paths: AecSPaths) => Promise<string>;
  serviceHealth: (paths: AecSPaths, attempts?: number) => Promise<ServiceHealth>;
  configureWorkBuddy: (paths: AecSPaths) => Promise<FrontAgentConfiguration>;
  now: () => string;
};

const HOST_LABELS: Record<HostReadiness["checks"][number]["id"], [string, string]> = {
  macos: ["macOS", "macOS"],
  node: ["Node.js", "Node.js"],
  npm: ["npm", "npm"],
  git: ["Git", "Git"],
  githubCli: ["GitHub CLI", "GitHub CLI"],
  githubAuth: ["GitHub Authentication", "GitHub 认证"],
  shell: ["Shell", "Shell"],
  path: ["PATH", "PATH"],
  dataDirectory: ["AEC-S data directory", "AEC-S 数据目录"],
};

function tr(language: OnboardingLanguage, english: string, chinese: string): string {
  return language === "zh-CN" ? chinese : english;
}

function label(language: OnboardingLanguage, pair: [string, string]): string {
  return language === "zh-CN" ? pair[1] : pair[0];
}

function familyLabel(family: string | undefined): string {
  if (family === "deepseek_harness") return "DeepSeek Harness";
  if (family === "kimi") return "Kimi Code";
  if (family === "codex") return "Codex";
  return family ?? "Runtime";
}

function runtimePool(initialization: InitializationResult): Array<{ family: string; available: boolean; version?: string }> {
  const families = [...new Set(initialization.runtimes.map((runtime) => runtime.family).filter((family): family is string => Boolean(family)))];
  return families.map((family) => {
    const members = initialization.runtimes.filter((runtime) => runtime.family === family);
    return {
      family,
      available: members.length > 0 && members.every((runtime) => runtime.ready),
      version: members.find((runtime) => runtime.version)?.version,
    };
  });
}

function showHostReadiness(prompt: WizardPrompt, host: HostReadiness, language: OnboardingLanguage): void {
  prompt.write(`${tr(language, "Automatic environment detection", "自动环境探测")}\n\n`);
  for (const check of host.checks) {
    const optional = check.required ? "" : tr(language, " (optional)", "（可选）");
    prompt.write(`${check.ok ? "✓" : check.required ? "✗" : "○"} ${label(language, HOST_LABELS[check.id])}${optional} — ${check.detail}\n`);
  }
  prompt.write("\n");
}

function showRuntimePool(prompt: WizardPrompt, initialization: InitializationResult, language: OnboardingLanguage): void {
  prompt.write(`${tr(language, "Worker Pool", "Worker Pool 状态")}\n\n`);
  for (const runtime of runtimePool(initialization)) {
    const status = runtime.available ? "AVAILABLE" : "UNAVAILABLE";
    prompt.write(`${familyLabel(runtime.family).padEnd(20)} ${status}${runtime.version ? `  ${runtime.version}` : ""}\n`);
  }
  if (!initialization.workerReady) {
    prompt.write(`\n${tr(language,
      "AEC-S is installed, but no Worker Runtime is currently callable. Install or authenticate one Runtime before submitting Tasks.",
      "AEC-S 已完成安装，但当前没有可调用的 Worker Runtime。这不会阻塞安装；提交 Task 前请安装或认证至少一个 Runtime。",
    )}\n`);
  }
  prompt.write("\n");
}

function healthUrl(endpoint: string): string {
  return endpoint.replace(/\/mcp$/, "/healthz");
}

export async function probeServiceHealth(paths: AecSPaths, attempts = 10): Promise<ServiceHealth> {
  const endpoint = `http://127.0.0.1:${mcpHttpPort()}/mcp`;
  const status = await serviceAction("status", paths).catch(() => "Not running");
  const serviceRunning = !status.startsWith("Not running");
  let mcpRunning = false;
  for (let attempt = 0; serviceRunning && attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl(endpoint), { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        mcpRunning = true;
        break;
      }
    } catch {
      // The LaunchAgent may still be starting. Retry within the bounded window.
    }
    if (attempt + 1 < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return { serviceRunning, mcpRunning, endpoint };
}

export async function configureWorkBuddy(paths: AecSPaths): Promise<FrontAgentConfiguration> {
  const binary = discoverExecutable("codebuddy");
  if (!binary) return { kind: "workbuddy", configured: false, detail: "WorkBuddy CLI was not found" };
  const existing = await execCommand({ program: binary, args: ["mcp", "get", "aec-s"], timeoutSeconds: 30 });
  if (existing.exitCode === 0) return { kind: "workbuddy", configured: true, detail: "Existing AEC-S MCP connection reused" };
  const entry = process.env.AEC_S_CLI_ENTRY?.trim() || process.argv[1];
  if (!entry) return { kind: "workbuddy", configured: false, detail: "AEC-S CLI entry could not be resolved" };
  const configuration = JSON.stringify({
    type: "stdio",
    command: realpathSync(process.execPath),
    args: [realpathSync(resolve(entry)), "mcp"],
    env: { AEC_S_HOME: paths.home },
  });
  const added = await execCommand({
    program: binary,
    args: ["mcp", "add-json", "--scope", "user", "aec-s", configuration],
    timeoutSeconds: 30,
  });
  return added.exitCode === 0
    ? { kind: "workbuddy", configured: true, detail: "WorkBuddy user MCP connection configured" }
    : { kind: "workbuddy", configured: false, detail: added.stderr.trim() || added.stdout.trim() || "WorkBuddy rejected the MCP configuration" };
}

async function configureFrontAgent(
  prompt: WizardPrompt,
  language: OnboardingLanguage,
  paths: AecSPaths,
  endpoint: string,
  configure: (paths: AecSPaths) => Promise<FrontAgentConfiguration>,
): Promise<FrontAgentConfiguration> {
  prompt.write(`${tr(language,
    "The Front Agent is your natural-language entry point to AEC-S. Prefer an Agent that is not also your primary Coding Worker.",
    "Front Agent 是你通过自然语言与 AEC-S 交互的入口。建议不要选择同时承担主要 Coding 工作的 Agent。",
  )}\n\n`);
  const selected = await prompt.select("Front Agent", [
    { value: "workbuddy", label: "WorkBuddy", description: tr(language, "recommended", "推荐") },
    { value: "custom", label: tr(language, "Custom MCP Agent", "自定义 MCP Agent") },
    { value: "skipped", label: tr(language, "Skip for now", "暂时跳过") },
  ]);
  if (selected === "workbuddy") {
    const result = await configure(paths);
    prompt.write(`${result.configured ? "✓" : "!"} WorkBuddy — ${result.detail ?? ""}\n\n`);
    if (!result.configured) {
      prompt.write(`${tr(language, "MCP Endpoint", "MCP Endpoint")}: ${endpoint}\n`);
      prompt.write(`${tr(language, "Authentication token file", "认证令牌文件")}: ${paths.mcpHttpToken}\n\n`);
    }
    return result;
  }
  if (selected === "custom") {
    prompt.write(`${tr(language, "MCP Endpoint", "MCP Endpoint")}: ${endpoint}\n`);
    prompt.write(`${tr(language, "Authentication token file", "认证令牌文件")}: ${paths.mcpHttpToken}\n`);
    prompt.write(`${tr(language,
      "Configure the token as a Bearer secret in the client; do not copy it into a project or chat.",
      "请在客户端中把该令牌配置为 Bearer Secret，不要将其复制到项目或聊天中。",
    )}\n\n`);
    return { kind: "custom", configured: true, detail: endpoint };
  }
  return { kind: "skipped", configured: false };
}

async function importFirstProject(
  prompt: WizardPrompt,
  language: OnboardingLanguage,
  inspect: (path: string) => Promise<ProjectInspection>,
): Promise<Project | undefined> {
  const action = await prompt.select(tr(language, "First project", "第一个项目"), [
    { value: "import", label: tr(language, "Import project", "导入项目") },
    { value: "later", label: tr(language, "Later", "稍后") },
  ]);
  if (action === "later") return undefined;
  const path = await prompt.input(tr(language, "Project directory", "项目目录"), { required: true });
  const inspection = await inspect(path);
  prompt.write(`\n${formatProjectInspection(inspection, language)}\n`);
  const selectedValidation = [];
  for (let index = 0; index < inspection.detected.validationCandidates.length; index += 1) {
    const candidate = inspection.detected.validationCandidates[index]!;
    if (await prompt.confirm(tr(language,
      `Use “${candidate}” as authoritative validation?`,
      `将“${candidate}”作为权威验证？`,
    ))) selectedValidation.push(inspection.project.defaultValidation?.[index]);
  }
  const intent = await prompt.input(tr(language, "Project Intent", "项目 Intent"), { required: true });
  let deliveryMode: "local" | "github" = "local";
  let requiredChecks: string[] = [];
  if (inspection.detected.github) {
    deliveryMode = await prompt.select(tr(language, "Delivery mode", "交付模式"), [
      { value: "local", label: tr(language, "Local", "本地") },
      { value: "github", label: "GitHub" },
    ]);
    if (deliveryMode === "github") {
      for (const check of inspection.detected.requiredCheckCandidates) {
        if (await prompt.confirm(tr(language, `Require GitHub Check “${check}”?`, `要求 GitHub Check“${check}”？`))) {
          requiredChecks.push(check);
        }
      }
      if (requiredChecks.length === 0) {
        requiredChecks = [await prompt.input(tr(language, "Required GitHub Check name", "Required GitHub Check 名称"), { required: true })];
      }
    }
  }
  const projectInput = projectInputSchema.parse({
    ...inspection.project,
    intent,
    deliveryMode,
    defaultValidation: selectedValidation.filter((command) => command !== undefined),
    ...(deliveryMode === "github" ? { requiredChecks } : { requiredChecks: [] }),
  });
  const db = new AecSDatabase();
  try {
    const existing = db.listProjects().find((candidate) => candidate.repoPath === projectInput.repoPath);
    if (existing) return existing;
    if (projectInput.id && db.getProject(projectInput.id)) {
      projectInput.id = `${projectInput.id}-${fingerprint(projectInput.repoPath).slice(0, 8)}`;
    }
    return db.createProject(projectInput);
  } finally {
    db.close();
  }
}

function defaultDependencies(prompt: WizardPrompt = new TerminalWizardPrompt()): SetupWizardDependencies {
  return {
    prompt,
    initialize: initializeAecS,
    probeHost: probeHostReadiness,
    inspectProject,
    installService: async (paths) => await serviceAction("install", paths),
    restartService: async (paths) => await serviceAction("restart", paths),
    serviceHealth: probeServiceHealth,
    configureWorkBuddy,
    now: () => new Date().toISOString(),
  };
}

export async function runSetupWizard(overrides: Partial<SetupWizardDependencies> = {}): Promise<SetupWizardResult> {
  const dependencies = { ...defaultDependencies(overrides.prompt), ...overrides };
  const { prompt } = dependencies;
  const paths = getAecSPaths();
  const existingState = readOnboardingState(paths);
  let state: OnboardingState;
  if (existingState) {
    state = existingState;
  } else {
    const selectedLanguage = await prompt.select<OnboardingLanguage>("请选择语言 / Select language", [
      { value: "zh-CN", label: "中文" },
      { value: "en", label: "English" },
    ]);
    state = { schemaVersion: 1, status: "in_progress", language: selectedLanguage, startedAt: dependencies.now() };
    writeOnboardingState(paths, state);
  }
  const language = state.language;

  prompt.write("\nAEC-S\nAgent Equilibrium Control System\n\n");
  prompt.write(`${tr(language,
    "AEC-S runs as a local engineering control system. It coordinates Coding Agents, project state, Git/GitHub, validation, review, and decisions that require you.",
    "AEC-S 将作为本机工程控制系统运行，协调 Coding Agent、项目状态、Git/GitHub、Validation、Review 和需要你参与的 Decision。",
  )}\n\n`);
  if (!(await prompt.confirm(tr(language, "Continue installation?", "继续安装？")))) {
    prompt.write(`${tr(language, "Installation paused. Run `aec-s` to continue.", "安装已暂停。再次运行 `aec-s` 可继续。")}\n`);
    return { completed: false, state };
  }

  const host = await dependencies.probeHost();
  showHostReadiness(prompt, host, language);
  if (!host.ready) {
    prompt.write(`${tr(language,
      "AEC-S stopped before changing system services. Resolve the required checks marked ✗ and run `aec-s` again.",
      "AEC-S 已在更改系统服务前停止。请处理标为 ✗ 的必要检查，然后再次运行 `aec-s`。",
    )}\n`);
    return { completed: false, state };
  }

  const initialization = await dependencies.initialize({ installService: false });
  prompt.write(`${tr(language, "Runtime discovery", "Runtime 自动发现")}\n\n`);
  showRuntimePool(prompt, initialization, language);

  if (state.serviceEnabled === undefined) {
    prompt.write(`${tr(language,
      "AEC-S can start automatically after login so it can maintain project state and coordinate Agents while unattended.",
      "AEC-S 希望在登录后自动启动，以便持续维护项目状态并在无人值守时协调 Agent。",
    )}\n\n`);
    state = { ...state, serviceEnabled: await prompt.confirm(tr(language, "Allow the background service?", "允许后台服务？")) };
    writeOnboardingState(paths, state);
  }

  let health: ServiceHealth = {
    serviceRunning: false,
    mcpRunning: false,
    endpoint: `http://127.0.0.1:${mcpHttpPort()}/mcp`,
  };
  if (state.serviceEnabled) {
    try {
      await dependencies.installService(paths);
      health = await dependencies.serviceHealth(paths);
      if (!health.serviceRunning || !health.mcpRunning) {
        await dependencies.restartService(paths);
        health = await dependencies.serviceHealth(paths);
      }
    } catch (error) {
      prompt.write(`${tr(language, "Background installation failed", "后台安装失败")}: ${error instanceof Error ? error.message : String(error)}\n`);
      prompt.write(`${tr(language, "AEC-S made no credential changes. Run `aec-s` after resolving this issue.", "AEC-S 未更改任何凭据。处理该问题后请再次运行 `aec-s`。")}\n`);
      return { completed: false, state };
    }
    prompt.write(`${health.serviceRunning ? "✓" : "✗"} AEC-S Core\n`);
    prompt.write(`${health.serviceRunning ? "✓" : "✗"} ${tr(language, "Background Service", "后台服务")}\n`);
    prompt.write(`✓ ${tr(language, "State Storage", "状态存储")}\n`);
    prompt.write(`${health.mcpRunning ? "✓" : "✗"} MCP Server\n\n`);
    if (!health.mcpRunning) {
      prompt.write(`${tr(language, "MCP self-check did not converge after one automatic restart. Run `aec-s doctor` for the remaining issue.", "MCP 自检在一次自动重启后仍未收敛。请运行 `aec-s doctor` 查看剩余问题。")}\n`);
      return { completed: false, state };
    }
    prompt.write(`Endpoint:\n${health.endpoint}\n\n`);
  } else {
    prompt.write(`✓ ${tr(language, "State Storage", "状态存储")}\n`);
    prompt.write(`○ ${tr(language, "Background Service skipped; stdio MCP remains available on demand.", "已跳过后台服务；stdio MCP 仍可按需使用。")}\n\n`);
  }

  if (!state.frontAgent) {
    state = {
      ...state,
      mcpEndpoint: health.mcpRunning ? health.endpoint : undefined,
      frontAgent: await configureFrontAgent(prompt, language, paths, health.endpoint, dependencies.configureWorkBuddy),
    };
    writeOnboardingState(paths, state);
  }
  showRuntimePool(prompt, initialization, language);

  let project: Project | undefined;
  if (!state.projectId) {
    project = await importFirstProject(prompt, language, dependencies.inspectProject);
    if (project) {
      state = { ...state, projectId: project.id };
      writeOnboardingState(paths, state);
    }
  }

  state = { ...state, status: "complete", completedAt: dependencies.now() };
  writeOnboardingState(paths, state);
  prompt.write("AEC-S Ready\n\n");
  prompt.write(`Core                ${state.serviceEnabled ? "Running" : "Ready"}\n`);
  prompt.write(`Background Service  ${state.serviceEnabled ? "Running" : "Skipped"}\n`);
  prompt.write(`MCP                 ${health.mcpRunning ? "Running" : "On demand"}\n`);
  prompt.write(`Front Agent         ${state.frontAgent?.kind === "workbuddy" ? "WorkBuddy" : state.frontAgent?.kind === "custom" ? "Custom" : "Not configured"}\n`);
  for (const runtime of runtimePool(initialization)) {
    prompt.write(`${familyLabel(runtime.family).padEnd(20)} ${runtime.available ? "Available" : "Unavailable"}\n`);
  }
  prompt.write(`Project             ${project?.name ?? (state.projectId || tr(language, "Not imported", "尚未导入"))}\n\n`);
  prompt.write(`${tr(language,
    "Initialization complete. You can close this terminal. AEC-S will continue in the background when the service is enabled.",
    "初始化完成。你现在可以关闭终端；启用后台服务时，AEC-S 将继续在后台运行。",
  )}\n`);
  return { completed: true, state };
}

export async function formatDailyControl(language: OnboardingLanguage): Promise<string> {
  const paths = getAecSPaths();
  const state = readOnboardingState(paths);
  const db = new AecSDatabase();
  try {
    const health = await probeServiceHealth(paths, 1);
    const agents = db.listAgents();
    const projects = db.listProjects();
    const families = [...new Set(agents.map((agent) => agent.runtimeFamily).filter((family): family is string => Boolean(family)))];
    const runtimeLines = families.map((family) => {
      const members = agents.filter((agent) => agent.runtimeFamily === family);
      const available = members.length > 0 && members.every((agent) => ["available", "busy", "healthy"].includes(agent.availability));
      return `${familyLabel(family).padEnd(20)} ${available ? "AVAILABLE" : "UNAVAILABLE"}`;
    });
    return [
      "AEC-S",
      "Agent Equilibrium Control System",
      "",
      `${tr(language, "Core", "Core").padEnd(20)} READY`,
      `${tr(language, "Background Service", "后台服务").padEnd(20)} ${health.serviceRunning ? "RUNNING" : state?.serviceEnabled ? "STOPPED" : "DISABLED"}`,
      `${"MCP".padEnd(20)} ${health.mcpRunning ? "RUNNING" : "STOPPED"}`,
      `${tr(language, "Front Agent", "Front Agent").padEnd(20)} ${state?.frontAgent?.kind ?? "not configured"}`,
      "",
      ...runtimeLines,
      "",
      `${tr(language, "Projects", "项目")}: ${projects.length === 0 ? tr(language, "none", "无") : projects.map((project) => project.name).join(", ")}`,
      "",
      tr(language, "Common commands", "常用命令"),
      "  aec-s status",
      "  aec-s doctor",
      "  aec-s project list",
      "  aec-s agent list",
      "  aec-s service status",
      "",
    ].join("\n");
  } finally {
    db.close();
  }
}

export function languageFromState(): OnboardingLanguage | undefined {
  return readOnboardingState(getAecSPaths())?.language;
}

export function runtimeAvailability(agents: Agent[]): Record<string, boolean> {
  return Object.fromEntries([...new Set(agents.map((agent) => agent.runtimeFamily).filter(Boolean))].map((family) => [
    family!,
    agents.filter((agent) => agent.runtimeFamily === family).every((agent) => ["available", "busy", "healthy"].includes(agent.availability)),
  ]));
}
