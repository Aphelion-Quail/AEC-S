import type { AecDatabase } from "./db.js";
import { execCommand } from "./exec.js";

export async function doctor(db: AecDatabase): Promise<Record<string, unknown>> {
  const commands = [
    ["git", ["--version"]],
    ["codex", ["--version"]],
    ["gh", ["--version"]],
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
  const auth = await execCommand({ program: "gh", args: ["auth", "status"], timeoutSeconds: 30 }).catch((error) => ({
    exitCode: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    signal: null,
    timedOut: false,
  }));
  return {
    ok: Number(process.versions.node.split(".")[0]) >= 26 && Boolean((tools.git as { ok: boolean }).ok),
    node: { version: process.version, ok: Number(process.versions.node.split(".")[0]) >= 26 },
    database: db.paths.database,
    tools,
    githubAuth: { ok: auth.exitCode === 0, detail: auth.stdout.trim() || auth.stderr.trim() },
  };
}
