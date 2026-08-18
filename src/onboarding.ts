import { existsSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AecSDatabase } from "./db.js";
import { AecSEngine } from "./engine.js";
import { execCommand } from "./exec.js";
import { branchHead, currentBranch } from "./git.js";
import { getAecSPaths } from "./paths.js";
import { serviceAction } from "./service.js";
import type { AgentInput, ProjectInput } from "./types.js";
import { DSH_COMPATIBILITY, type RuntimeProbeResult } from "./runtime-probe.js";

function legacySchemaVersion(database: string): number | undefined {
  if (!existsSync(database)) return undefined;
  const db = new DatabaseSync(database);
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
  } finally {
    db.close();
  }
}

export async function initializeAecS(options: { installService?: boolean } = {}): Promise<Record<string, unknown>> {
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
    const engine = new AecSEngine(db);
    // Two successful probes recover a Runtime; three consecutive failures
    // cross the default debounce threshold and make the failure explicit.
    let probes = new Map<string, RuntimeProbeResult>();
    probes = await engine.refreshAgentAvailability();
    probes = await engine.refreshAgentAvailability();
    probes = await engine.refreshAgentAvailability();
    const service = options.installService === false ? "skipped" : await serviceAction("install", paths);
    return {
      home: paths.home,
      ...(archivedHome ? { archivedHome, archivedSchemaVersion: version } : {}),
      service,
      runtimes: db.listAgents().map((agent) => ({
        id: agent.id,
        family: agent.runtimeFamily,
        role: agent.roles[0],
        availability: agent.availability,
        version: agent.runtimeVersion,
        probe: probes.get(agent.id),
      })),
      guidance: {
        en: "AEC-S reports installation, authentication, SDK/protocol compatibility, and background access separately. Follow only the failed check; AEC-S never writes or copies credentials.",
        zhCN: "AEC-S 分别报告安装、认证、SDK/协议兼容性和后台访问。只需处理失败的检查项；AEC-S 永不写入或复制凭据。",
      },
    };
  } finally {
    db.close();
  }
}

async function gitValue(repoPath: string, args: string[]): Promise<string | undefined> {
  const result = await execCommand({ program: "git", args, cwd: repoPath, timeoutSeconds: 30 });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

export async function inspectProject(repoPathInput: string): Promise<{ project: ProjectInput; detected: Record<string, unknown> }> {
  const repoPath = resolve(repoPathInput);
  const branch = await currentBranch(repoPath);
  const remoteUrl = await gitValue(repoPath, ["remote", "get-url", "origin"]);
  const packageJsonPath = join(repoPath, "package.json");
  let packageJson: { name?: string; scripts?: Record<string, string>; engines?: Record<string, string> } = {};
  if (existsSync(packageJsonPath)) {
    packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(packageJsonPath, "utf8")) as typeof packageJson;
  }
  const scripts = packageJson.scripts ?? {};
  const validationNames = ["check", "lint", "test"].filter((name) => typeof scripts[name] === "string");
  const docs = ["README.md", "README.zh-CN.md", "ARCHITECTURE.md", "docs/architecture.md"]
    .filter((path) => existsSync(join(repoPath, path)));
  const project: ProjectInput = {
    id: basename(repoPath).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "imported-project",
    name: packageJson.name ?? basename(repoPath),
    repoPath,
    targetBranch: branch,
    remoteName: "origin",
    deliveryMode: "local",
    intent: "[Human confirmation required]",
    intentVersion: 1,
    environmentContract: {
      version: 1,
      components: [
        { id: "node", version: packageJson.engines?.node },
        { id: "git", version: await gitValue(repoPath, ["--version"]) },
      ],
    },
    defaultValidation: validationNames.map((name) => ({ program: "npm", args: ["run", name] })),
    postMergeSmoke: [],
    maxConcurrency: 3,
  };
  return {
    project,
    detected: {
      head: await branchHead(repoPath, "HEAD"),
      remoteUrl,
      github: Boolean(remoteUrl?.includes("github.com")),
      stack: existsSync(packageJsonPath) ? ["node"] : [],
      validationCandidates: validationNames,
      architectureDocuments: docs,
      requiredHumanConfirmation: ["intent", "authoritativeGates", "undetectableEnvironmentRequirements", "directionalConstraints"],
    },
  };
}
