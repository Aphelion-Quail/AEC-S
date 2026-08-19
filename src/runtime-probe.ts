import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { LocalCredentialProvider } from "@deepseek-ai/dsh-credentials-local";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { isLoggedIn, ProtocolClient } from "@moonshot-ai/kimi-agent-sdk";
import { execCommand } from "./exec.js";
import { KIMI_ACP_CLIENT_VERSION, probeKimiAcp } from "./kimi-acp.js";
import { redactText } from "./redaction.js";
import { within } from "./async.js";
import { childEnvironment } from "./child-env.js";

export type ProbeCheck = {
  ok: boolean;
  detail: string;
};

export type RuntimeProbeResult = {
  ok: boolean;
  detail: string;
  version?: string;
  transport?: "acp" | "agent_sdk_wire";
  checks?: {
    installation: ProbeCheck;
    authentication: ProbeCheck;
    compatibility: ProbeCheck;
    backgroundAccess: ProbeCheck;
    isolation?: ProbeCheck;
  };
};

export const DSH_COMPATIBILITY = Object.freeze({
  packageVersion: "0.1.0-rc.6",
  serverName: "deepseek-harness-sdk-runtime",
  serverVersion: "0.0.1",
});

const require = createRequire(import.meta.url);
const KIMI_SDK_VERSION = packageVersion("@moonshot-ai/kimi-agent-sdk");
const DSH_PACKAGE_NAMES = [
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-agent-spine-demo",
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-credentials-local",
  "@deepseek-ai/dsh-fs-local",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-deepseek",
  "@deepseek-ai/dsh-sandbox-local",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-sdk-client",
  "@deepseek-ai/dsh-sdk-jsonrpc-demo",
  "@deepseek-ai/dsh-sdk-jsonrpc-server",
  "@deepseek-ai/dsh-sdk-protocol",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-persistence-jsonl",
  "@deepseek-ai/dsh-subprocess-local",
  "@deepseek-ai/dsh-terminal",
  "@deepseek-ai/dsh-terminal-bash",
  "@deepseek-ai/dsh-tool-bash-persistent",
  "@deepseek-ai/dsh-tool-str-replace-editor",
] as const;
const DSH_PINNED_PACKAGES = [
  ["@deepseek-ai/cordis", "4.0.1"],
  ...DSH_PACKAGE_NAMES.map((name) => [name, DSH_COMPATIBILITY.packageVersion] as const),
] as const;

function packageVersion(name: string): string {
  let packagePath: string | undefined;
  try {
    packagePath = require.resolve(`${name}/package.json`);
  } catch {
    let directory = dirname(require.resolve(name));
    while (true) {
      const candidate = join(directory, "package.json");
      if (existsSync(candidate)) {
        const value = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
        if (value.name === name && typeof value.version === "string") return value.version;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (!packagePath) throw new Error(`${name} package metadata is unavailable`);
  const value = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error(`${name} does not publish a package version`);
  return value.version;
}

function errorDetail(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 1_000);
}

function resultFromChecks(
  version: string,
  checks: NonNullable<RuntimeProbeResult["checks"]>,
): RuntimeProbeResult {
  const failed = Object.values(checks).find((check) => !check.ok);
  return {
    ok: failed === undefined,
    detail: failed?.detail ?? version,
    version,
    checks,
  };
}

export async function probeCodex(binary: string): Promise<RuntimeProbeResult> {
  let versionResult;
  try {
    versionResult = await execCommand({ program: binary, args: ["--version"], timeoutSeconds: 10 }, undefined, "codex");
  } catch (error) {
    const detail = `Codex CLI is not executable: ${errorDetail(error)}`;
    const failed = { ok: false, detail };
    return resultFromChecks("codex-cli/unavailable", {
      installation: failed,
      authentication: { ok: false, detail: "Authentication was not checked because Codex is unavailable" },
      compatibility: { ok: false, detail: "Compatibility was not checked because Codex is unavailable" },
      backgroundAccess: { ok: false, detail: "The AEC-S process cannot execute Codex" },
    });
  }
  const version = (versionResult.stdout.trim() || versionResult.stderr.trim()).split(/\r?\n/, 1)[0] ?? "unknown";
  const installation: ProbeCheck = versionResult.exitCode === 0
    ? { ok: true, detail: `Codex CLI/${version} at ${binary}` }
    : { ok: false, detail: `Codex version probe failed: ${errorDetail(versionResult.stderr || versionResult.stdout)}` };
  const login = installation.ok
    ? await execCommand({ program: binary, args: ["login", "status"], timeoutSeconds: 15 }, undefined, "codex")
    : undefined;
  const authentication: ProbeCheck = login?.exitCode === 0
    ? { ok: true, detail: redactText(login.stdout.trim() || login.stderr.trim() || "Codex login is available") }
    : { ok: false, detail: login ? `Codex authentication is unavailable: ${errorDetail(login.stderr || login.stdout)}` : "Authentication was not checked" };
  const help = installation.ok
    ? await execCommand({ program: binary, args: ["exec", "--help"], timeoutSeconds: 15 }, undefined, "codex")
    : undefined;
  const helpText = `${help?.stdout ?? ""}\n${help?.stderr ?? ""}`;
  const requiredFlags = ["--sandbox", "--json", "--output-schema", "--output-last-message"];
  const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
  const compatibility: ProbeCheck = help?.exitCode === 0 && missingFlags.length === 0
    ? { ok: true, detail: "Codex exec exposes the required sandbox and structured-output controls" }
    : { ok: false, detail: `Codex exec compatibility is missing: ${missingFlags.join(", ") || errorDetail(helpText)}` };
  const backgroundAccess: ProbeCheck = installation.ok && authentication.ok
    ? { ok: true, detail: "The authenticated Codex CLI is executable by the AEC-S process" }
    : { ok: false, detail: "The AEC-S process cannot use an authenticated Codex CLI" };
  return resultFromChecks(version, { installation, authentication, compatibility, backgroundAccess });
}

function kimiShareDirectories(binary: string): string[] {
  const configured = process.env.KIMI_SHARE_DIR?.trim();
  const binaryHome = dirname(dirname(resolve(binary)));
  return [...new Set([
    ...(configured ? [resolve(configured)] : []),
    binaryHome,
    join(homedir(), ".kimi-code"),
    join(homedir(), ".kimi"),
  ])];
}

export function discoverKimiShareDirectory(binary: string): string | undefined {
  for (const directory of kimiShareDirectories(binary)) {
    try {
      if (isLoggedIn(directory)) return directory;
    } catch {
      // Continue across legacy and current Kimi configuration layouts.
    }
  }
  return undefined;
}

async function kimiAuthentication(binary: string): Promise<ProbeCheck> {
  const sdkEvidence = discoverKimiShareDirectory(binary) !== undefined;
  const providers = await execCommand(
    { program: binary, args: ["provider", "list"], timeoutSeconds: 15 },
    undefined,
    "kimi",
  );
  const providerEvidence = providers.exitCode === 0
    && /\bmodels=[1-9][0-9]*\b/.test(providers.stdout)
    && /\bsource=(?:oauth|api[_-]?key|credential)\b/i.test(providers.stdout);
  if (sdkEvidence || providerEvidence) {
    return { ok: true, detail: providerEvidence ? "Kimi provider metadata confirms authentication" : "Kimi SDK metadata confirms authentication" };
  }
  return { ok: false, detail: "Kimi Code CLI is installed but no authenticated provider is visible to the AEC-S process" };
}

async function kimiLegacyCompatibility(
  binary: string,
  workspace: string,
  shareDirectory?: string,
): Promise<ProbeCheck & { wireVersion?: string; serverVersion?: string }> {
  const client = new ProtocolClient();
  try {
    const initialized = await within(client.start({
      workDir: workspace,
      executablePath: binary,
      ...(shareDirectory ? { environmentVariables: { KIMI_SHARE_DIR: shareDirectory } } : {}),
      clientInfo: { name: "aec-s-probe", version: "0.9.0-rc.1" },
    }), 15_000, "Kimi SDK initialize");
    return {
      ok: true,
      detail: `Kimi SDK wire ${initialized.protocol_version}; ${initialized.server.name}/${initialized.server.version}`,
      wireVersion: initialized.protocol_version,
      serverVersion: initialized.server.version,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Kimi SDK ${KIMI_SDK_VERSION} cannot initialize this CLI: ${errorDetail(error)}`,
    };
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function kimiCompatibility(
  binary: string,
  workspace: string,
  shareDirectory?: string,
  transport: "acp" | "agent_sdk_wire" = "acp",
): Promise<{
  check: ProbeCheck;
  transport?: "acp" | "agent_sdk_wire";
  runtimeVersion?: string;
}> {
  if (transport === "agent_sdk_wire") {
    const legacy = await kimiLegacyCompatibility(binary, workspace, shareDirectory);
    return {
      check: legacy,
      ...(legacy.ok ? { transport: "agent_sdk_wire", runtimeVersion: legacy.serverVersion } : {}),
    };
  }
  try {
    const compatible = await probeKimiAcp({
      binary,
      workspace,
      ...(shareDirectory ? { shareDir: shareDirectory } : {}),
    });
    return {
      check: {
        ok: true,
        detail: `Kimi ACP ${compatible.protocolVersion}; ${compatible.agentName}/${compatible.agentVersion}; session create/delete and load/resume exercised; cancel/stream negotiated; plan and auto modes available`,
      },
      transport: "acp",
      runtimeVersion: compatible.agentVersion,
    };
  } catch (acpError) {
    const legacy = await kimiLegacyCompatibility(binary, workspace, shareDirectory);
    return {
      check: {
        ok: false,
        detail: `Kimi ACP ${KIMI_ACP_CLIENT_VERSION} is required but unavailable: ${errorDetail(acpError)}; ` +
          `legacy SDK is ${legacy.ok ? "available only through explicit transport=agent_sdk_wire" : `also unavailable: ${legacy.detail}`}`,
      },
    };
  }
}

export async function probeKimi(
  binary: string,
  workspace = process.cwd(),
  transport: "acp" | "agent_sdk_wire" = "acp",
): Promise<RuntimeProbeResult> {
  let versionResult;
  try {
    versionResult = await execCommand({ program: binary, args: ["--version"], timeoutSeconds: 10 }, undefined, "kimi");
  } catch (error) {
    const detail = `Kimi Code CLI is not executable: ${errorDetail(error)}`;
    const failed = { ok: false, detail };
    return resultFromChecks(`kimi-agent-sdk/${KIMI_SDK_VERSION}`, {
      installation: failed,
      authentication: { ok: false, detail: "Authentication was not checked because the CLI is unavailable" },
      compatibility: { ok: false, detail: "Compatibility was not checked because the CLI is unavailable" },
      backgroundAccess: { ok: false, detail: "The AEC-S background process cannot execute the CLI" },
    });
  }
  const cliVersion = (versionResult.stdout.trim() || versionResult.stderr.trim()).split(/\r?\n/, 1)[0] ?? "unknown";
  const installation: ProbeCheck = versionResult.exitCode === 0
    ? { ok: true, detail: `Kimi Code CLI/${cliVersion} at ${binary}` }
    : { ok: false, detail: `Kimi Code CLI version probe failed: ${errorDetail(versionResult.stderr || versionResult.stdout)}` };
  const authentication = installation.ok
    ? await kimiAuthentication(binary)
    : { ok: false, detail: "Authentication was not checked because the CLI version probe failed" };
  const compatibilityResult = installation.ok
    ? await kimiCompatibility(binary, workspace, discoverKimiShareDirectory(binary), transport)
    : { check: { ok: false, detail: "Compatibility was not checked because the CLI version probe failed" } };
  const compatibility = compatibilityResult.check;
  const backgroundAccess: ProbeCheck = authentication.ok
    ? { ok: true, detail: "The authenticated Kimi provider is visible in the AEC-S process environment" }
    : { ok: false, detail: "The AEC-S process cannot see an authenticated Kimi provider" };
  const result = resultFromChecks(
    `kimi-acp-sdk/${KIMI_ACP_CLIENT_VERSION}; kimi-agent-sdk/${KIMI_SDK_VERSION}; kimi-code-cli/${cliVersion}`,
    {
    installation,
    authentication,
    compatibility,
    backgroundAccess,
    },
  );
  return { ...result, ...(compatibilityResult.transport ? { transport: compatibilityResult.transport } : {}) };
}

function dshPackageCheck(): ProbeCheck {
  const mismatches: string[] = [];
  for (const [name, expected] of DSH_PINNED_PACKAGES) {
    try {
      const actual = packageVersion(name);
      if (actual !== expected) mismatches.push(`${name}/${actual} (expected ${expected})`);
    } catch (error) {
      mismatches.push(`${name}/missing (${errorDetail(error)})`);
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      detail: `DSH package set mismatch: ${mismatches.join(", ")}`,
    };
  }
  return { ok: true, detail: `DSH package set ${DSH_COMPATIBILITY.packageVersion} and Cordis 4.0.1 are complete` };
}

async function dshAuthentication(dshHome?: string): Promise<ProbeCheck & { source?: string }> {
  const ctx = new Context();
  const fiber = ctx.plugin(LocalCredentialProvider, {
    ...(dshHome ? { dshHome } : {}),
    watch: false,
  });
  try {
    await fiber;
    const info = await ctx.credentials.describe(credentialRef("DEEPSEEK_API_KEY"));
    return info.configured
      ? { ok: true, detail: `DSH credential provider confirms DEEPSEEK_API_KEY from ${info.source ?? "configured source"}`, ...(info.source ? { source: info.source } : {}) }
      : { ok: false, detail: "DSH credential provider cannot resolve DEEPSEEK_API_KEY from the inherited environment or DSH home" };
  } catch (error) {
    return { ok: false, detail: `DSH credential provider failed safely: ${errorDetail(error)}` };
  } finally {
    await fiber.dispose().catch(() => undefined);
  }
}

async function dshHandshake(
  command: string,
  configs: string[],
  workspace: string,
  dshHome?: string,
): Promise<ProbeCheck> {
  const stateRoot = await mkdtemp(join(tmpdir(), "aec-s-dsh-probe-"));
  try {
    for (const [index, config] of configs.entries()) {
      if (!existsSync(config)) return { ok: false, detail: `AEC-S DSH composition is missing: ${config}` };
      const client = new HarnessClient({
        command,
        args: [config],
        cwd: workspace,
        env: childEnvironment("deepseek_harness", {
          DSH_CWD: workspace,
          DSH_SESSION_ROOT: join(stateRoot, String(index)),
          ...(dshHome ? { DSH_HOME: dshHome } : {}),
        }),
        requestTimeoutMs: 10_000,
        shutdownTimeoutMs: 1_000,
      });
      try {
        client.start();
        const initialized = await within(client.initialize({
          cwd: workspace,
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
        }), 15_000, "DSH initialize");
        if (initialized.serverInfo.name !== DSH_COMPATIBILITY.serverName
          || initialized.serverInfo.version !== DSH_COMPATIBILITY.serverVersion) {
          return {
            ok: false,
            detail: `DSH wire identity mismatch: expected ${DSH_COMPATIBILITY.serverName}/${DSH_COMPATIBILITY.serverVersion}, got ${initialized.serverInfo.name}/${initialized.serverInfo.version}`,
          };
        }
      } catch (error) {
        return { ok: false, detail: `DSH composition initialize failed: ${errorDetail(error)}` };
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    return { ok: true, detail: `DSH Executor and Reviewer compositions initialized as ${DSH_COMPATIBILITY.serverName}/${DSH_COMPATIBILITY.serverVersion}` };
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

export async function probeDeepSeekHarness(options: {
  command: string;
  configs: string[];
  workspace?: string;
  dshHome?: string;
  requestedPackageVersion?: unknown;
}): Promise<RuntimeProbeResult> {
  const workspace = options.workspace ?? process.cwd();
  const installation = dshPackageCheck();
  if (options.requestedPackageVersion !== undefined
    && options.requestedPackageVersion !== DSH_COMPATIBILITY.packageVersion) {
    installation.ok = false;
    installation.detail = `DSH package mismatch: AEC-S supports ${DSH_COMPATIBILITY.packageVersion}, configuration requested ${String(options.requestedPackageVersion)}`;
  }
  if (!existsSync(options.command)) {
    installation.ok = false;
    installation.detail = `Pinned DSH JSON-RPC runtime is missing: ${options.command}`;
  }
  const authentication = await dshAuthentication(options.dshHome);
  const compatibility = installation.ok
    ? await dshHandshake(options.command, options.configs, workspace, options.dshHome)
    : { ok: false, detail: "DSH initialize was not attempted because the pinned package set is unavailable" };
  const backgroundAccess: ProbeCheck = authentication.ok
    ? { ok: true, detail: "The DSH credential seam is readable by the AEC-S process without copying a secret into AEC-S" }
    : { ok: false, detail: "The AEC-S process cannot resolve the DSH credential seam" };
  return resultFromChecks(
    `dsh-packages/${DSH_COMPATIBILITY.packageVersion}; dsh-wire/${DSH_COMPATIBILITY.serverVersion}`,
    { installation, authentication, compatibility, backgroundAccess },
  );
}
