import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
