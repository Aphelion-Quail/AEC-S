import { existsSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AecSDatabase } from "./db.js";
import { AecSEngine } from "./engine.js";
import type { AgentAdapter } from "./adapters/agent.js";
import { execCommand } from "./exec.js";
import { branchHead, currentBranch, safeGitCommand } from "./git.js";
import { redactText } from "./redaction.js";
import { getAecSPaths } from "./paths.js";
import { serviceAction } from "./service.js";
import type { Agent, AgentInput, Project, ProjectInput } from "./types.js";
import { DSH_COMPATIBILITY, type RuntimeProbeResult } from "./runtime-probe.js";
import { fingerprint } from "./fingerprint.js";
import { projectInputSchema } from "./input.js";

export type OnboardingLanguage = "en" | "zh-CN";

export type RuntimeReadiness = {
  id: string;
  family?: string;
  role?: string;
  availability: string;
  version?: string;
  ready: boolean;
  probe?: RuntimeProbeResult;
};

export type InitializationResult = {
  home: string;
  archivedHome?: string;
  archivedSchemaVersion?: number;
  service: string;
  ready: boolean;
  workerReady: boolean;
  runtimes: RuntimeReadiness[];
  nextActions: Array<{ id: string; command?: string }>;
};

export function registerInspectedProject(db: AecSDatabase, input: ProjectInput): Project {
  const project = projectInputSchema.parse({ ...input, repoPath: realpathSync(resolve(input.repoPath)) }) as ProjectInput;
  const existing = db.listProjects().find((candidate) => candidate.repoPath === project.repoPath);
  if (existing) return existing;
  if (project.id && db.getProject(project.id)) {
    const baseId = project.id;
    const digest = fingerprint(project.repoPath);
    let length = 8;
    do {
      project.id = `${baseId}-${digest.slice(0, length)}`;
      length += 4;
    } while (db.getProject(project.id) && length <= digest.length + 4);
    if (db.getProject(project.id)) throw new Error(`Unable to derive a unique Project ID for ${project.repoPath}`);
  }
  return db.createProject(project);
}

export type HostReadinessCheck = {
  id: "macos" | "node" | "npm" | "git" | "githubCli" | "githubAuth" | "shell" | "path" | "dataDirectory";
  ok: boolean;
  required: boolean;
  detail: string;
};

export type HostReadiness = {
  ready: boolean;
  checks: HostReadinessCheck[];
};

export type ProjectInspection = {
  project: ProjectInput;
  detected: {
    head: string;
    remoteUrl?: string;
    github: boolean;
    stack: string[];
    packageManager?: string;
    validationCandidates: string[];
    ciWorkflows: string[];
    requiredCheckCandidates: string[];
    architectureDocuments: string[];
    requiredHumanConfirmation: string[];
  };
};

function legacySchemaVersion(database: string): number | undefined {
  if (!existsSync(database)) return undefined;
  const db = new DatabaseSync(database);
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
  } finally {
    db.close();
  }
}

export async function initializeAecS(options: {
  installService?: boolean;
  adapterFactory?: (agent: Agent) => AgentAdapter;
} = {}): Promise<InitializationResult> {
  let paths = getAecSPaths();
  const version = legacySchemaVersion(paths.database);
  let archivedHome: string | undefined;
  if (version !== undefined && version > 0 && version < 5) {
    await serviceAction("stop", paths);
    archivedHome = `${paths.home}.pre-1.0-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(paths.home, archivedHome);
    paths = getAecSPaths();
  }

  const db = new AecSDatabase(paths.home);
  try {
    const registrations: AgentInput[] = [
      { id: "codex-executor", name: "Codex Executor", adapter: "codex", runtimeFamily: "codex", roles: ["executor"] },
      { id: "codex-reviewer", name: "Codex Reviewer", adapter: "codex", runtimeFamily: "codex", roles: ["reviewer"] },
      { id: "kimi-executor", name: "Kimi Executor", adapter: "kimi", runtimeFamily: "kimi", roles: ["executor"] },
      { id: "kimi-reviewer", name: "Kimi Reviewer", adapter: "kimi", runtimeFamily: "kimi", roles: ["reviewer"] },
      {
        id: "dsh-executor", name: "DeepSeek Harness Executor", adapter: "deepseek_harness",
        runtimeFamily: "deepseek_harness", roles: ["executor"], config: { packageVersion: DSH_COMPATIBILITY.packageVersion },
      },
      {
        id: "dsh-reviewer", name: "DeepSeek Harness Reviewer", adapter: "deepseek_harness",
        runtimeFamily: "deepseek_harness", roles: ["reviewer"], config: { packageVersion: DSH_COMPATIBILITY.packageVersion },
      },
    ];
    for (const registration of registrations) {
      if (!db.getAgent(registration.id!)) db.createAgent({ ...registration, availability: "registered" });
    }
    const engine = new AecSEngine(db, { adapterFactory: options.adapterFactory });
    // Installation records one real health sample. Repeating the same probe
    // here would inflate latency and misclassify one transient fault as the
    // configured multi-sample failure threshold.
    const probes = await engine.refreshAgentAvailability();
    const service = options.installService === false ? "skipped" : await serviceAction("install", paths);
    const runtimes: RuntimeReadiness[] = db.listAgents().map((agent) => {
      const probe = probes.get(agent.id);
      return {
        id: agent.id,
        family: agent.runtimeFamily,
        role: agent.roles[0],
        availability: agent.availability,
        version: agent.runtimeVersion,
        ready: probe?.ok === true && ["healthy", "available", "busy"].includes(agent.availability),
        probe,
      };
    });
    // A missing optional Runtime never blocks Core installation. At least one
    // ready family is needed to execute work, but users can install or repair
    // additional families after onboarding without rebuilding AEC-S state.
    const workerReady = runtimes.some((runtime) => runtime.ready);
    return {
      home: paths.home,
      ...(archivedHome ? { archivedHome, archivedSchemaVersion: version } : {}),
      service,
      ready: true,
      workerReady,
      runtimes,
      nextActions: [
        ...(!workerReady ? [{ id: "install_runtime" }] : []),
        { id: "import_project", command: "aec-s project import /absolute/path/to/project" },
      ],
    };
  } finally {
    db.close();
  }
}

async function commandReadiness(
  id: HostReadinessCheck["id"],
  program: string,
  args: string[],
  required: boolean,
): Promise<HostReadinessCheck> {
  try {
    const result = await execCommand({ program, args, timeoutSeconds: 15 });
    return {
      id,
      ok: result.exitCode === 0,
      required,
      detail: (result.stdout.trim() || result.stderr.trim() || `${program} exited ${result.exitCode}`).split(/\r?\n/, 1)[0]!,
    };
  } catch (error) {
    return { id, ok: false, required, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function probeHostReadiness(): Promise<HostReadiness> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const paths = getAecSPaths();
  const checks: HostReadinessCheck[] = [
    {
      id: "macos",
      ok: process.platform === "darwin",
      required: true,
      detail: process.platform === "darwin" ? `macOS ${process.arch}` : `Unsupported platform: ${process.platform}`,
    },
    {
      id: "node",
      ok: Number.isInteger(nodeMajor) && nodeMajor >= 26,
      required: true,
      detail: process.version,
    },
    await commandReadiness("npm", "npm", ["--version"], true),
    await commandReadiness("git", "git", ["--version"], true),
    await commandReadiness("githubCli", "gh", ["--version"], false),
    await commandReadiness("githubAuth", "gh", ["auth", "status"], false),
    {
      id: "shell",
      ok: Boolean(process.env.SHELL?.trim()),
      required: true,
      detail: process.env.SHELL?.trim() || "SHELL is not available",
    },
    {
      id: "path",
      ok: Boolean(process.env.PATH?.trim()),
      required: true,
      detail: process.env.PATH?.trim() ? "PATH is available to AEC-S" : "PATH is empty",
    },
    {
      id: "dataDirectory",
      ok: true,
      required: true,
      detail: paths.home,
    },
  ];
  return { ready: checks.every((check) => !check.required || check.ok), checks };
}

function workflowFacts(repoPath: string): { workflows: string[]; checks: string[] } {
  const directory = join(repoPath, ".github", "workflows");
  if (!existsSync(directory)) return { workflows: [], checks: [] };
  const workflows: string[] = [];
  const checks = new Set<string>();
  for (const filename of readdirSync(directory).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
    const content = readFileSync(join(directory, filename), "utf8");
    const workflowName = content.match(/^name:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    workflows.push(workflowName ?? filename);
    const lines = content.split(/\r?\n/);
    const jobsIndex = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
    if (jobsIndex < 0) continue;
    for (let index = jobsIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^\S/.test(line) && line.trim() && !line.trimStart().startsWith("#")) break;
      const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/)?.[1];
      if (!job) continue;
      let displayName: string | undefined;
      for (let nested = index + 1; nested < lines.length; nested += 1) {
        const nestedLine = lines[nested]!;
        if (/^ {2}\S/.test(nestedLine)) break;
        const found = nestedLine.match(/^ {4}name:\s*["']?([^\n"']+)["']?\s*$/)?.[1]?.trim();
        if (found) {
          displayName = found;
          break;
        }
      }
      checks.add(displayName ?? job);
    }
  }
  return { workflows, checks: [...checks].sort() };
}

function packageManager(repoPath: string, packageJson: { packageManager?: string }): string | undefined {
  if (packageJson.packageManager) return packageJson.packageManager;
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  return undefined;
}

function lockfileSourceHosts(repoPath: string): string[] {
  const hosts = new Set<string>();
  for (const filename of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const path = join(repoPath, filename);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8").slice(0, 16 * 1024 * 1024);
    for (const match of content.matchAll(/https:\/\/[^\s"'<>]+/g)) {
      try {
        const url = new URL(match[0].replace(/[),\]}]+$/, ""));
        const host = url.hostname.toLowerCase().replace(/\.$/, "");
        if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) &&
            !host.endsWith(".local") && !host.endsWith(".localhost")) hosts.add(host);
      } catch { /* A malformed lock source is ignored and cannot expand network authority. */ }
    }
  }
  return [...hosts];
}

async function gitValue(repoPath: string, args: string[]): Promise<string | undefined> {
  const result = await execCommand(safeGitCommand(repoPath, args, 30));
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function toolVersion(repoPath: string, program: string, args: string[]): Promise<string | undefined> {
  const result = await execCommand({ program, args, cwd: repoPath, timeoutSeconds: 15 }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  return (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/, 1)[0] || undefined;
}

export async function inspectProject(repoPathInput: string): Promise<ProjectInspection> {
  const repoPath = resolve(repoPathInput);
  const branch = await currentBranch(repoPath);
  const remotes = (await gitValue(repoPath, ["remote"]))?.split(/\r?\n/).filter(Boolean) ?? [];
  const remoteName = remotes.includes("origin") ? "origin" : remotes[0] ?? "origin";
  const remoteHead = await gitValue(repoPath, ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`]);
  const targetBranch = remoteHead?.startsWith(`${remoteName}/`) ? remoteHead.slice(remoteName.length + 1) : branch;
  const remoteUrl = await gitValue(repoPath, ["remote", "get-url", remoteName]);
  const packageJsonPath = join(repoPath, "package.json");
  let packageJson: {
    name?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  if (existsSync(packageJsonPath)) {
    packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(packageJsonPath, "utf8")) as typeof packageJson;
  }
  const scripts = packageJson.scripts ?? {};
  const validationNames = typeof scripts["test:all"] === "string"
    ? ["test:all"]
    : typeof scripts.validate === "string"
      ? ["validate"]
      : ["check", "typecheck", "lint", "test", "build"].filter((name) => typeof scripts[name] === "string");
  const docs = ["README.md", "README.zh-CN.md", "ARCHITECTURE.md", "docs/architecture.md"]
    .filter((path) => existsSync(join(repoPath, path)));
  const workflow = workflowFacts(repoPath);
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const manager = packageManager(repoPath, packageJson);
  const managerCommand = manager?.split("@")[0] || "npm";
  const hasFlutter = existsSync(join(repoPath, "pubspec.yaml"));
  const hasRust = existsSync(join(repoPath, "Cargo.toml"));
  const hasGo = existsSync(join(repoPath, "go.mod"));
  const hasPython = existsSync(join(repoPath, "pyproject.toml")) || existsSync(join(repoPath, "pytest.ini"));
  const dependencyHosts = [
    ...(existsSync(packageJsonPath) ? ["registry.npmjs.org"] : []),
    ...(hasFlutter ? ["pub.dev", "storage.googleapis.com"] : []),
    ...(hasRust ? ["crates.io", "index.crates.io", "static.crates.io"] : []),
    ...(hasGo ? ["proxy.golang.org", "sum.golang.org"] : []),
    ...(hasPython ? ["pypi.org", "files.pythonhosted.org"] : []),
    ...(existsSync(join(repoPath, "build.gradle")) || existsSync(join(repoPath, "build.gradle.kts"))
      ? ["plugins.gradle.org", "services.gradle.org", "repo.maven.apache.org"] : []),
    ...lockfileSourceHosts(repoPath),
  ];
  const stack = [
    ...(existsSync(packageJsonPath) ? ["node"] : []),
    ...(existsSync(join(repoPath, "tsconfig.json")) || dependencies.typescript ? ["typescript"] : []),
    ...(hasFlutter ? ["flutter"] : []),
    ...(hasRust ? ["rust"] : []),
    ...(hasGo ? ["go"] : []),
    ...(hasPython ? ["python"] : []),
  ];
  const extraValidations = [
    ...(hasFlutter ? [{ name: "flutter test", command: { program: "flutter", args: ["test"] } }] : []),
    ...(hasRust ? [{ name: "cargo test", command: { program: "cargo", args: ["test"] } }] : []),
    ...(hasGo ? [{ name: "go test ./...", command: { program: "go", args: ["test", "./..."] } }] : []),
    ...(hasPython ? [{ name: "pytest", command: { program: "pytest", args: [] } }] : []),
  ];
  const environmentComponents = [
    { id: "git", version: await toolVersion(repoPath, "git", ["--version"]), command: { program: "git", args: ["--version"] } },
    ...(existsSync(packageJsonPath) ? [{
      id: "node",
      version: packageJson.engines?.node ?? process.version,
      command: { program: "node", args: ["--version"] },
    }] : []),
    ...(manager ? [{
      id: "package-manager",
      version: manager.includes("@") ? manager.slice(manager.indexOf("@") + 1) : await toolVersion(repoPath, managerCommand, ["--version"]),
      command: { program: managerCommand, args: ["--version"] },
    }] : []),
    ...(hasFlutter ? [{ id: "flutter", version: await toolVersion(repoPath, "flutter", ["--version"]), command: { program: "flutter", args: ["--version"] } }] : []),
    ...(hasRust ? [{ id: "cargo", version: await toolVersion(repoPath, "cargo", ["--version"]), command: { program: "cargo", args: ["--version"] } }] : []),
    ...(hasGo ? [{ id: "go", version: await toolVersion(repoPath, "go", ["version"]), command: { program: "go", args: ["version"] } }] : []),
    ...(hasPython ? [{ id: "python", version: await toolVersion(repoPath, "python3", ["--version"]), command: { program: "python3", args: ["--version"] } }] : []),
  ];
  const project: ProjectInput = {
    id: basename(repoPath).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "imported-project",
    name: packageJson.name ?? basename(repoPath),
    repoPath,
    targetBranch,
    remoteName,
    deliveryMode: "local",
    intent: "[Human confirmation required]",
    intentVersion: 1,
    environmentContract: {
      version: 1,
      components: environmentComponents,
    },
    operationalConfig: { networkPolicy: { mode: "brokered", dependencyHosts: [...new Set(dependencyHosts)].sort() } },
    defaultValidation: [
      ...validationNames.map((name) => ({ program: managerCommand, args: ["run", name] })),
      ...extraValidations.map((validation) => validation.command),
    ],
    postMergeSmoke: [],
    maxConcurrency: 3,
  };
  return {
    project,
    detected: {
      head: await branchHead(repoPath, "HEAD"),
      remoteUrl: remoteUrl ? redactText(remoteUrl) : undefined,
      github: Boolean(remoteUrl?.includes("github.com")),
      stack,
      packageManager: manager,
      validationCandidates: [...validationNames, ...extraValidations.map((validation) => validation.name)],
      ciWorkflows: workflow.workflows,
      requiredCheckCandidates: workflow.checks,
      architectureDocuments: docs,
      requiredHumanConfirmation: ["intent", "deliveryMode", "authoritativeGates"],
    },
  };
}

function checkLabel(key: string, language: OnboardingLanguage): string {
  const labels: Record<string, [string, string]> = {
    installation: ["installation", "安装"],
    authentication: ["authentication", "认证"],
    compatibility: ["protocol compatibility", "协议兼容性"],
    backgroundAccess: ["background access", "后台访问"],
    isolation: ["process isolation", "进程隔离"],
  };
  const label = labels[key] ?? [key, key];
  return language === "zh-CN" ? label[1] : label[0];
}

function familyLabel(family: string | undefined): string {
  if (family === "deepseek_harness") return "DeepSeek Harness";
  if (family === "kimi") return "Kimi Code CLI";
  if (family === "codex") return "Codex";
  return family ?? "Runtime";
}

export function formatInitialization(result: InitializationResult, language: OnboardingLanguage): string {
  const zh = language === "zh-CN";
  const lines = [zh ? "AEC-S 环境检测" : "AEC-S environment readiness", ""];
  const families = [...new Set(result.runtimes.map((runtime) => runtime.family))];
  for (const family of families) {
    const members = result.runtimes.filter((runtime) => runtime.family === family);
    const ready = members.every((runtime) => runtime.ready);
    const first = members[0];
    lines.push(`${ready ? "✓" : "✗"} ${familyLabel(family)}${first?.version ? ` — ${first.version}` : ""}`);
    if (!ready) {
      const checks = first?.probe?.checks;
      if (checks) {
        for (const [key, check] of Object.entries(checks)) {
          if (!check.ok) lines.push(`  - ${checkLabel(key, language)}: ${check.detail}`);
        }
      } else if (first?.probe?.detail) {
        lines.push(`  - ${first.probe.detail}`);
      }
    }
  }
  lines.push("", `${zh ? "后台服务" : "Background service"}: ${result.service}`);
  if (result.archivedHome) {
    lines.push(`${zh ? "旧状态已原子归档" : "Legacy state was atomically archived"}: ${result.archivedHome}`);
  }
  lines.push("");
  lines.push(zh ? "AEC-S Core 已就绪，无需手动配置凭据。" : "AEC-S Core is ready; no manual credential configuration is required.");
  if (!result.workerReady) {
    lines.push(zh
      ? "当前没有可调用的 Worker Runtime；这不会阻塞安装，但提交 Task 前至少需要一个可用 Runtime。"
      : "No Worker Runtime is currently callable. Installation is not blocked, but at least one Runtime is required before submitting Tasks.");
  }
  lines.push(zh ? "下一步：aec-s project import /项目的绝对路径" : "Next: aec-s project import /absolute/path/to/project");
  return `${lines.join("\n")}\n`;
}

export function formatProjectInspection(
  inspection: ProjectInspection,
  language: OnboardingLanguage,
  applied?: Project,
): string {
  const zh = language === "zh-CN";
  const { project, detected } = inspection;
  const list = (values: string[]) => values.length > 0 ? values.join(", ") : (zh ? "未检测到" : "none detected");
  const lines = [zh ? "AEC-S 项目导入" : "AEC-S project import", ""];
  lines.push(`${zh ? "项目" : "Project"}: ${project.name}`);
  lines.push(`${zh ? "仓库" : "Repository"}: ${project.repoPath}`);
  lines.push(`${zh ? "目标分支" : "Target branch"}: ${project.targetBranch}`);
  lines.push(`${zh ? "技术栈" : "Stack"}: ${list(detected.stack)}`);
  lines.push(`${zh ? "环境契约" : "Environment contract"}: ${list((project.environmentContract?.components ?? []).map((component) => `${component.id}${component.version ? `=${component.version}` : ""}`))}`);
  lines.push(`${zh ? "包管理器" : "Package manager"}: ${detected.packageManager ?? (zh ? "未检测到" : "not detected")}`);
  lines.push(`${zh ? "验证候选" : "Validation candidates"}: ${list(detected.validationCandidates)}`);
  lines.push(`${zh ? "CI 工作流" : "CI workflows"}: ${list(detected.ciWorkflows)}`);
  lines.push(`${zh ? "Required Check 候选" : "Required Check candidates"}: ${list(detected.requiredCheckCandidates)}`);
  lines.push(`${zh ? "架构文档" : "Architecture documents"}: ${list(detected.architectureDocuments)}`);
  lines.push("");
  if (applied) {
    lines.push(`${zh ? "✓ 项目已注册" : "✓ Project registered"}: ${applied.id}`);
    lines.push(zh ? "下一步：运行 `aec-s doctor`，然后通过 MCP 或 `aec-s graph submit` 提交首个任务。"
      : "Next: run `aec-s doctor`, then submit the first task through MCP or `aec-s graph submit`.");
  } else {
    lines.push(zh ? "以上内容仅为提案，尚未写入 AEC-S。" : "This is a proposal; nothing has been written to AEC-S.");
    lines.push(zh
      ? `确认 Intent 和检测到的 Gate 后运行：aec-s project import ${project.repoPath} --apply --intent "<项目目标>" --accept-detected-gates`
      : `After confirming Intent and detected gates, run: aec-s project import ${project.repoPath} --apply --intent "<project intent>" --accept-detected-gates`);
  }
  return `${lines.join("\n")}\n`;
}
