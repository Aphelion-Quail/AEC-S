import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand } from "./exec.js";
import type { AecPaths } from "./paths.js";

const LABEL = "dev.aec.core";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function serviceAction(action: "install" | "start" | "stop" | "restart" | "status" | "uninstall", paths: AecPaths): Promise<string> {
  const plist = plistPath();
  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (action === "install") {
    const entry = process.env.AEC_CLI_ENTRY ?? process.argv[1];
    if (!entry) throw new Error("Unable to locate AEC CLI entry");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(realpathSync(process.execPath))}</string>
    <string>${xml(realpathSync(entry))}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>AEC_HOME</key><string>${xml(paths.home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(paths.logs, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(paths.logs, "daemon.stderr.log"))}</string>
</dict></plist>
`;
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
