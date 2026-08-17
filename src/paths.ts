import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type AecSPaths = {
  home: string;
  database: string;
  runs: string;
  workspaces: string;
  logs: string;
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
  };
}

export function ensureAecSPaths(paths: AecSPaths): void {
  for (const path of [paths.home, paths.runs, paths.workspaces, paths.logs]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
