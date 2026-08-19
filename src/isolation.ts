import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChildEnvironmentProfile, CommandSpec, ProcessIsolation } from "./types.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), absolute.slice(parent.length + 1));
}

function seatbeltString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function subpaths(paths: string[]): string {
  return [...new Set(paths.map(canonical))].map((path) => `(subpath ${seatbeltString(path)})`).join(" ");
}

type GitMetadata = { gitDir: string; commonDir: string };

function resolveGitMetadata(worktreePath: string): GitMetadata {
  const dotGit = join(canonical(worktreePath), ".git");
  if (!existsSync(dotGit)) throw new Error(`Git metadata is missing for isolated worktree: ${worktreePath}`);
  const gitDir = statSync(dotGit).isDirectory()
    ? canonical(dotGit)
    : (() => {
        const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(dotGit, "utf8"));
        if (!match?.[1]) throw new Error(`Git metadata pointer is malformed for isolated worktree: ${worktreePath}`);
        return canonical(isAbsolute(match[1]) ? match[1] : resolve(dirname(dotGit), match[1]));
      })();
  const commonPointer = join(gitDir, "commondir");
  const commonDir = existsSync(commonPointer)
    ? canonical(resolve(gitDir, readFileSync(commonPointer, "utf8").trim()))
    : gitDir;
  return { gitDir, commonDir };
}

export function gitMetadataReadPaths(workspacePath: string, projectRepoPath: string): string[] {
  const workspace = resolveGitMetadata(workspacePath);
  const project = resolveGitMetadata(projectRepoPath);
  if (workspace.commonDir !== project.commonDir) {
    throw new Error(`Isolated worktree Git metadata does not belong to its registered Project: ${workspacePath}`);
  }
  return [...new Set([workspace.gitDir, workspace.commonDir])];
}

function executablePath(program: string, path = process.env.PATH ?? ""): string | undefined {
  if (isAbsolute(program)) return existsSync(program) ? canonical(program) : undefined;
  for (const entry of path.split(delimiter)) {
    const candidate = join(entry, program);
    if (existsSync(candidate)) return canonical(candidate);
  }
  return undefined;
}

export function runtimeAccessPaths(
  profile: ChildEnvironmentProfile,
  runtimeRoots: string[] = [],
): { credentialReadPaths: string[]; stateWritePaths: string[] } {
  const home = homedir();
  const configured = profile === "codex"
    ? process.env.CODEX_HOME
    : profile === "kimi" ? process.env.KIMI_SHARE_DIR : profile === "deepseek_harness" ? process.env.DSH_HOME : undefined;
  const defaults = profile === "codex"
    ? [join(home, ".codex")]
    : profile === "kimi"
      ? [join(home, ".kimi-code"), join(home, ".kimi"), join(home, "Library", "Caches", "kimi-code")]
      : profile === "deepseek_harness" ? [join(home, ".deepseek-harness"), join(home, ".dsh")] : [];
  const protectedRoots = new Set([canonical("/"), canonical(homedir()), canonical("/Users"), canonical("/Volumes")]);
  const roots = [...new Set((runtimeRoots.length > 0
    ? runtimeRoots
    : [...(configured ? [configured] : []), ...defaults]).filter(existsSync).map(canonical))];
  for (const path of roots) {
    if (protectedRoots.has(path)) throw new Error(`Runtime state grant is too broad for process isolation: ${path}`);
  }
  const mutableNames = profile === "codex"
    ? ["sessions", "shell_snapshots", ".tmp", "tmp", "session_index.jsonl", "history.jsonl", "models_cache.json"]
    : profile === "kimi"
      ? ["cache", "search-index", "server", "updates", "sessions", "logs", "user-history", "telemetry", "workspace-trust", "workspaces.json", "session_index.jsonl", "migrations-effort.json"]
      : profile === "deepseek_harness"
        ? ["storages", "sessions", ".anonymous-user-id"]
        : [];
  return {
    credentialReadPaths: roots,
    stateWritePaths: roots.flatMap((root) => mutableNames.map((name) => join(root, name))),
  };
}

export function nodeCoverageDirectory(source: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = source.NODE_V8_COVERAGE;
  if (!configured || !existsSync(configured) || !statSync(configured).isDirectory()) return undefined;
  const directory = canonical(configured);
  const temporaryRoot = canonical(tmpdir());
  const child = relative(temporaryRoot, directory);
  return child && !child.startsWith(`..${sep}`) && child !== ".." && !child.includes(sep) && child.startsWith("node-coverage-")
    ? directory
    : undefined;
}

export function isolationEnvironment(
  isolation: ProcessIsolation,
  profile: ChildEnvironmentProfile,
): Record<string, string> {
  mkdirSync(isolation.homePath, { recursive: true, mode: 0o700 });
  mkdirSync(isolation.tempPath, { recursive: true, mode: 0o700 });
  const environment: Record<string, string> = {
    HOME: isolation.homePath,
    XDG_CACHE_HOME: join(isolation.homePath, ".cache"),
    XDG_CONFIG_HOME: join(isolation.homePath, ".config"),
    XDG_DATA_HOME: join(isolation.homePath, ".local", "share"),
    TMPDIR: isolation.tempPath,
    TMP: isolation.tempPath,
    TEMP: isolation.tempPath,
    SSH_AUTH_SOCK: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  if (profile === "codex") environment.CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return environment;
}

export function isolatedCommand(command: CommandSpec, isolation: ProcessIsolation): CommandSpec {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    throw new Error("AEC-S Runtime isolation requires macOS sandbox-exec; execution cannot safely continue");
  }
  const userHome = canonical(homedir());
  const userTemp = process.env.TMPDIR ? canonical(process.env.TMPDIR) : undefined;
  const readPaths = [
    PACKAGE_ROOT,
    isolation.workspacePath,
    isolation.controllerPath,
    isolation.homePath,
    isolation.tempPath,
    ...(isolation.credentialReadPaths ?? []),
    ...(isolation.stateWritePaths ?? []),
    ...(isolation.gitMetadataPaths ?? []),
  ];
  const coverageDirectory = nodeCoverageDirectory();
  if (coverageDirectory) readPaths.push(coverageDirectory);
  const executable = executablePath(command.program);
  if (!executable) throw new Error(`Isolated command is not executable: ${command.program}`);
  readPaths.push(dirname(executable));
  const writePaths = [isolation.controllerPath, isolation.homePath, isolation.tempPath, ...(isolation.stateWritePaths ?? [])];
  if (coverageDirectory) writePaths.push(coverageDirectory);
  if (isolation.mode === "workspace-write") writePaths.push(isolation.workspacePath);
  const protectedReadRoots = [userHome, "/Users", "/Volumes", ...(userTemp ? [userTemp] : [])];
  const deniedPrograms = ["security", "ssh", "scp", "sftp", "gh", "git-credential-osxkeychain"];
  const deniedExecutables = [
    "/usr/bin/security",
    "/usr/bin/ssh",
    "/usr/bin/scp",
    "/usr/bin/sftp",
    "/usr/libexec/git-core/git-credential-osxkeychain",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    ...deniedPrograms.flatMap((program) => (process.env.PATH ?? "").split(delimiter).map((entry) => join(entry, program))),
  ].filter(existsSync).map(canonical);
  const profile = [
    "(version 1)",
    "(allow default)",
    ...(isolation.networkAccess === "none" ? ["(deny network*)"] : []),
    `(deny file-read-data ${subpaths(protectedReadRoots)})`,
    `(allow file-read-data ${subpaths(readPaths)})`,
    "(deny file-write*)",
    `(allow file-write* ${subpaths(writePaths)} (literal "/dev/null"))`,
    `(deny file-write* (literal ${seatbeltString(join(canonical(isolation.workspacePath), ".git"))}) ${subpaths(isolation.gitMetadataPaths ?? [])})`,
    "(deny signal)",
    "(allow signal (target self))",
    "(allow signal (target children))",
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.securityd.general"))',
    ...deniedExecutables.map((path) => `(deny process-exec (literal ${seatbeltString(path)}))`),
  ].join("\n");
  return {
    ...command,
    program: SANDBOX_EXEC,
    args: ["-p", profile, executable, ...command.args],
  };
}

export function probeProcessIsolation(): { ok: boolean; detail: string } {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    return { ok: false, detail: "macOS sandbox-exec is unavailable" };
  }
  const directory = mkdtempSync(join(tmpdir(), "aec-s-isolation-probe-"));
  const workspace = join(directory, "workspace");
  const controller = join(directory, "controller");
  const protectedPath = join(directory, "sentinel");
  const escapedWrite = join(directory, "escaped");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(controller, { mode: 0o700 });
  writeFileSync(protectedPath, "must-not-be-readable", { mode: 0o600 });
  try {
    const isolation = {
      workspacePath: workspace,
      mode: "workspace-write" as const,
      networkAccess: "none" as const,
      controllerPath: controller,
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    };
    const command = isolatedCommand({
      program: process.execPath,
      args: ["-e", `
        const fs=require('node:fs');
        const denied=(operation)=>{try{operation();return false}catch(error){return error.code==='EPERM'}};
        const readDenied=denied(()=>fs.readFileSync(${JSON.stringify(protectedPath)}));
        const writeDenied=denied(()=>fs.writeFileSync(${JSON.stringify(escapedWrite)},'x'));
        fs.writeFileSync(${JSON.stringify(join(workspace, "allowed"))},'ok');
        process.exit(readDenied&&writeDenied?0:1);
      `],
      cwd: workspace,
      timeoutSeconds: 5,
    }, isolation);
    const result = spawnSync(command.program, command.args, {
      encoding: "utf8",
      timeout: 5_000,
      cwd: workspace,
      env: { ...process.env, ...isolationEnvironment(isolation, "restricted") },
    });
    return result.status === 0 && !existsSync(escapedWrite) && existsSync(join(workspace, "allowed"))
      ? { ok: true, detail: "macOS Seatbelt process-tree and file-access enforcement is available" }
      : { ok: false, detail: "macOS Seatbelt probe did not enforce the required read/write boundary" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
