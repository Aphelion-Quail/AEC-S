import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type AecSPaths = {
  home: string;
  database: string;
  runs: string;
  workspaces: string;
  logs: string;
  mcpHttpToken: string;
};

export function getAecSPaths(explicitHome?: string): AecSPaths {
  const home = resolve(
    explicitHome ?? process.env.AEC_S_HOME ?? join(homedir(), "Library", "Application Support", "AEC-S"),
  );
  return {
    home,
    database: join(home, "aec-s.db"),
    runs: join(home, "runs"),
    workspaces: join(home, "workspaces"),
    logs: join(home, "logs"),
    mcpHttpToken: join(home, "mcp-http.token"),
  };
}

export function ensureAecSPaths(paths: AecSPaths): void {
  const protectedRoots = new Set([
    resolve("/"),
    resolve(homedir()),
    resolve(homedir(), "Desktop"),
    resolve(homedir(), "Documents"),
    resolve(homedir(), "Downloads"),
    resolve(homedir(), "Developer"),
    resolve("/Users"),
    resolve("/Volumes"),
    resolve("/tmp"),
  ]);
  if (protectedRoots.has(paths.home)) {
    throw new Error(`AEC_S_HOME is a protected broad directory and cannot be claimed by AEC-S: ${paths.home}`);
  }
  if (existsSync(paths.home)) {
    if (lstatSync(paths.home).isSymbolicLink()) {
      throw new Error(`AEC_S_HOME must not be a symbolic link: ${paths.home}`);
    }
    const knownEntries = new Set([
      "aec-s.db", "aec-s.db-shm", "aec-s.db-wal", "aec-s.db-journal", "runs", "workspaces", "logs", "reviews",
      "runtime-state", "mcp-http.token", "onboarding.json",
    ]);
    const entries = readdirSync(paths.home);
    const unexpected = entries.filter((entry) => entry !== ".DS_Store" && !knownEntries.has(entry));
    if (unexpected.length > 0) {
      throw new Error(`AEC_S_HOME points to a nonempty directory not owned by AEC-S: ${paths.home}`);
    }
  }
  for (const path of [paths.home, paths.runs, paths.workspaces, paths.logs]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  try {
    const descriptor = openSync(paths.mcpHttpToken, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${randomBytes(32).toString("base64url")}\n`);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  chmodSync(paths.mcpHttpToken, 0o600);
}

export function readMcpHttpToken(paths: AecSPaths): string {
  const token = readFileSync(paths.mcpHttpToken, "utf8").trim();
  if (token.length < 32) throw new Error("AEC-S MCP HTTP token is missing or invalid");
  return token;
}
