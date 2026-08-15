import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type AecPaths = {
  home: string;
  database: string;
  runs: string;
  workspaces: string;
  logs: string;
};

export function getAecPaths(explicitHome?: string): AecPaths {
  const home = resolve(
    explicitHome ?? process.env.AEC_HOME ?? join(homedir(), "Library", "Application Support", "AEC"),
  );
  return {
    home,
    database: join(home, "aec.db"),
    runs: join(home, "runs"),
    workspaces: join(home, "workspaces"),
    logs: join(home, "logs"),
  };
}

export function ensureAecPaths(paths: AecPaths): void {
  for (const path of [paths.home, paths.runs, paths.workspaces, paths.logs]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
