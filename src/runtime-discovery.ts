import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

export function executableCandidates(name: string): string[] {
  const fromPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, name));
  const known = name === "codex"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
      ]
    : name === "kimi"
      ? [join(homedir(), ".kimi-code", "bin", "kimi")]
    : name === "dsh-jsonrpc-agent"
      ? [join(homedir(), ".local", "bin", name)]
      : [];
  return [...new Set([...fromPath, ...known])];
}

export function discoverExecutable(name: string): string | undefined {
  return executableCandidates(name).find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
