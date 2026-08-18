import type { AecSDatabase } from "./db.js";
import { execCommand } from "./exec.js";
import { adapterFor } from "./adapters/agent.js";

export async function doctor(db: AecSDatabase): Promise<Record<string, unknown>> {
  const projects = db.listProjects();
  const commands = [
    ["git", ["--version"]],
    ...(projects.some((project) => project.deliveryMode === "github") ? [["gh", ["--version"]] as const] : []),
  ] as const;
  const tools: Record<string, unknown> = {};
  for (const [program, args] of commands) {
    const result = await execCommand({ program, args: [...args], timeoutSeconds: 15 }).catch((error) => ({
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      signal: null,
      timedOut: false,
    }));
    tools[program] = { ok: result.exitCode === 0, detail: result.stdout.trim() || result.stderr.trim() };
  }
  const githubNeeded = projects.some((project) => project.deliveryMode === "github");
  const auth = githubNeeded
    ? await safeExec("gh", ["auth", "status"], 30)
    : undefined;
  const projectChecks = await Promise.all(projects.map(async (project) => {
    const repository = await safeExec("git", ["-C", project.repoPath, "rev-parse", "--git-dir"], 15);
    if (repository.exitCode !== 0) {
      return { id: project.id, ok: false, detail: repository.stderr.trim() || "Not a Git repository" };
    }
    if (project.deliveryMode === "local") {
      const branch = await safeExec("git", ["-C", project.repoPath, "branch", "--show-current"], 15);
      const status = await safeExec("git", ["-C", project.repoPath, "status", "--porcelain=v1", "-z"], 15);
      const current = branch.stdout.trim();
      const clean = status.exitCode === 0 && status.stdout.length === 0;
      const correctBranch = branch.exitCode === 0 && current === project.targetBranch;
      return {
        id: project.id,
        ok: correctBranch && clean,
        detail: correctBranch && clean
          ? `Local target branch ${project.targetBranch} is checked out and clean`
          : correctBranch
            ? `Local target branch ${project.targetBranch} has uncommitted changes`
          : `Local delivery requires ${project.targetBranch} to be checked out; current branch is ${current || "unknown"}`,
      };
    }
    return { id: project.id, ok: true, detail: `GitHub delivery via ${project.remoteName}/${project.targetBranch}` };
  }));
  const agentProbeCache = new Map<string, ReturnType<ReturnType<typeof adapterFor>["probe"]>>();
  const agents = await Promise.all(db.listAgents().map(async (agent) => {
    try {
      const cacheKey = JSON.stringify({ adapter: agent.adapter, config: agent.config });
      let probe = agentProbeCache.get(cacheKey);
      if (!probe) {
        probe = adapterFor(agent).probe();
        agentProbeCache.set(cacheKey, probe);
      }
      return { id: agent.id, ...(await probe) };
    } catch (error) {
      return { id: agent.id, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }));
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 26;
  const allProjectsOk = projectChecks.every((project) => project.ok);
  const allEnabledAgentsOk = agents.every((result) => !db.getAgent(result.id)?.enabled || result.ok);
  const githubOk = !githubNeeded || auth?.exitCode === 0;
  return {
    ok: nodeOk && Boolean((tools.git as { ok: boolean }).ok) && allProjectsOk && allEnabledAgentsOk && githubOk,
    node: { version: process.version, ok: nodeOk },
    database: db.paths.database,
    tools,
    projects: projectChecks,
    agents,
    githubAuth: auth ? { ok: auth.exitCode === 0, detail: auth.stdout.trim() || auth.stderr.trim() } : { required: false },
  };
}

async function safeExec(program: string, args: string[], timeoutSeconds: number) {
  return await execCommand({ program, args, timeoutSeconds }).catch((error) => ({
    exitCode: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    signal: null,
    timedOut: false,
  }));
}
