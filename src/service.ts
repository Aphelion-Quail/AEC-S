import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execCommand } from "./exec.js";
import type { AecSPaths } from "./paths.js";

const LABEL = "dev.aec-s.core";

export function servicePath(): string {
  const configured = process.env.AEC_S_SERVICE_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    dirname(realpathSync(process.execPath)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    "/Applications/ChatGPT.app/Contents/Resources",
  ];
  return [...new Set(candidates.filter((candidate) => existsSync(candidate)))].join(":");
}

export function launchAgentPlist(
  entry: string,
  paths: AecSPaths,
  runtimePath = servicePath(),
  mcpHttpPort = process.env.AEC_S_MCP_HTTP_PORT?.trim(),
): string {
  const mcpPortEnvironment = mcpHttpPort
    ? `\n    <key>AEC_S_MCP_HTTP_PORT</key><string>${xml(mcpHttpPort)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(realpathSync(process.execPath))}</string>
    <string>${xml(realpathSync(entry))}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AEC_S_HOME</key><string>${xml(paths.home)}</string>
    <key>PATH</key><string>${xml(runtimePath)}</string>${mcpPortEnvironment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(paths.logs, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logs, "daemon.stderr.log"))}</string>
</dict></plist>
`;
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function serviceAction(action: "install" | "start" | "stop" | "restart" | "status" | "uninstall", paths: AecSPaths): Promise<string> {
  const plist = plistPath();
  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (action === "install") {
    const entry = process.env.AEC_S_CLI_ENTRY ?? process.argv[1];
    if (!entry) throw new Error("Unable to locate AEC-S CLI entry");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const content = launchAgentPlist(entry, paths);
    writeFileSync(plist, content, { mode: 0o600 });
    await execCommand({ program: "launchctl", args: ["bootout", domain, plist], timeoutSeconds: 30 });
    const loaded = await execCommand({ program: "launchctl", args: ["bootstrap", domain, plist], timeoutSeconds: 30 });
    if (loaded.exitCode !== 0) throw new Error(loaded.stderr.trim() || "launchctl bootstrap failed");
    return `Installed and started ${LABEL}`;
  }
  if (action === "uninstall") {
    await execCommand({ program: "launchctl", args: ["bootout", domain, plist], timeoutSeconds: 30 });
    if (existsSync(plist)) unlinkSync(plist);
    return `Uninstalled ${LABEL}`;
  }
  if (action === "start") {
    const result = await execCommand({ program: "launchctl", args: ["bootstrap", domain, plist], timeoutSeconds: 30 });
    if (result.exitCode !== 0 && !result.stderr.includes("already loaded")) throw new Error(result.stderr.trim());
    return `Started ${LABEL}`;
  }
  if (action === "stop") {
    await execCommand({ program: "launchctl", args: ["bootout", domain, plist], timeoutSeconds: 30 });
    return `Stopped ${LABEL}`;
  }
  if (action === "restart") {
    await execCommand({ program: "launchctl", args: ["kickstart", "-k", `${domain}/${LABEL}`], timeoutSeconds: 30 });
    return `Restarted ${LABEL}`;
  }
  const result = await execCommand({ program: "launchctl", args: ["print", `${domain}/${LABEL}`], timeoutSeconds: 30 });
  return result.exitCode === 0 ? result.stdout.trim() : `Not running: ${result.stderr.trim()}`;
}
