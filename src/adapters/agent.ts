import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Agent, CommandSpec } from "../types.js";
import { execCommand } from "../exec.js";
import { discoverExecutable } from "../runtime-discovery.js";
import {
  probeDeepSeekHarness,
  probeCodex,
  probeKimi,
  discoverKimiShareDirectory,
  type RuntimeProbeResult,
} from "../runtime-probe.js";

export type InvocationKind = "execute" | "repair" | "review";

const require = createRequire(import.meta.url);

export type AgentInvocation = {
  command: CommandSpec;
  stdin?: string;
  structuredOutputPath: string;
};

export type InvocationOptions = {
  kind: InvocationKind;
  prompt: string;
  workspacePath: string;
  runDir: string;
  schemaPath: string;
  sessionId?: string;
};

export interface AgentAdapter {
  probe(): Promise<RuntimeProbeResult>;
  healthcheck(): Promise<{ ok: boolean; detail: string }>;
  invocation(options: InvocationOptions): AgentInvocation;
  start(options: InvocationOptions): AgentInvocation;
  execute(options: InvocationOptions): AgentInvocation;
  review(options: InvocationOptions): AgentInvocation;
  repair(options: InvocationOptions): AgentInvocation;
  resume(options: InvocationOptions): AgentInvocation;
  cancel(pid: number): void;
  status(pid: number): "running" | "stopped";
  collectResult<T>(path: string): T;
  close(pid?: number): void;
  extractSessionId(stdoutPath: string): string | undefined;
  extractRuntimeVersion(stdoutPath: string): string | undefined;
  extractTokenUsage(stdoutPath: string): { input?: number; output?: number; total?: number } | undefined;
}

abstract class BaseAdapter implements AgentAdapter {
  abstract probe(): Promise<RuntimeProbeResult>;
  abstract invocation(options: InvocationOptions): AgentInvocation;
  abstract extractSessionId(stdoutPath: string): string | undefined;

  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    const { ok, detail } = await this.probe();
    return { ok, detail };
  }

  start(options: InvocationOptions): AgentInvocation { return this.invocation(options); }
  execute(options: InvocationOptions): AgentInvocation { return this.invocation({ ...options, kind: "execute" }); }
  review(options: InvocationOptions): AgentInvocation { return this.invocation({ ...options, kind: "review" }); }
  repair(options: InvocationOptions): AgentInvocation { return this.invocation({ ...options, kind: "repair" }); }
  resume(options: InvocationOptions): AgentInvocation { return this.invocation({ ...options, kind: "repair" }); }

  cancel(pid: number): void {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* Already stopped. */ } }
  }

  status(pid: number): "running" | "stopped" {
    try { process.kill(pid, 0); return "running"; } catch { return "stopped"; }
  }

  collectResult<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  close(pid?: number): void { if (pid) this.cancel(pid); }
  extractRuntimeVersion(_stdoutPath?: string): string | undefined { return undefined; }
  extractTokenUsage(_stdoutPath: string): { input?: number; output?: number; total?: number } | undefined { return undefined; }
}

function substitute(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => replacements[key] ?? `{${key}}`);
}

class CommandAdapter extends BaseAdapter {
  constructor(private readonly agent: Agent) { super(); }

  async probe(): Promise<RuntimeProbeResult> {
    const binary = String(this.agent.config.binary ?? "");
    if (!binary) return { ok: false, detail: "command adapter config.binary is required" };
    const result = await execCommand({ program: binary, args: ["--version"], timeoutSeconds: 10 });
    const detail = result.stdout.trim() || result.stderr.trim();
    return { ok: result.exitCode === 0, detail, ...(result.exitCode === 0 ? { version: detail } : {}) };
  }

  invocation(options: InvocationOptions): AgentInvocation {
    const config = (this.agent.config[options.kind] ?? this.agent.config.execute) as
      | { program?: string; args?: string[]; timeoutSeconds?: number }
      | undefined;
    const program = String(config?.program ?? this.agent.config.binary ?? "");
    if (!program) throw new Error(`Agent ${this.agent.id} command config is missing a program`);
    const output = join(options.runDir, `${options.kind}-result-${Date.now()}.json`);
    const replacements = {
      workspace: options.workspacePath,
      prompt: options.prompt,
      output,
      schema: options.schemaPath,
      session: options.sessionId ?? "",
    };
    const args = (config?.args ?? []).map((value) => substitute(value, replacements));
    return {
      command: {
        program,
        args,
        cwd: options.workspacePath,
        timeoutSeconds: config?.timeoutSeconds ?? 3600,
      },
      stdin: options.prompt,
      structuredOutputPath: output,
    };
  }

  extractSessionId(): string | undefined {
    return undefined;
  }
}

class CodexAdapter extends BaseAdapter {
  constructor(private readonly agent: Agent) { super(); }

  private binary(): string {
    return String(this.agent.config.binary ?? discoverExecutable("codex") ?? "codex");
  }

  async probe(): Promise<RuntimeProbeResult> {
    return await probeCodex(this.binary());
  }

  invocation(options: InvocationOptions): AgentInvocation {
    const output = join(options.runDir, `${options.kind}-result-${Date.now()}.json`);
    const model = typeof this.agent.config.model === "string" ? this.agent.config.model : undefined;
    const ignoreUserConfig = this.agent.config.ignoreUserConfig === true;
    const sandbox = options.kind === "review" ? "read-only" : "workspace-write";
    // These are Codex global options, so they must precede `exec`. In particular,
    // `exec resume` does not expose its own --sandbox/--cd flags and must receive
    // the same explicit boundary as a fresh invocation.
    const common = [
      "--ask-for-approval",
      "never",
      "--sandbox",
      sandbox,
      "--cd",
      options.workspacePath,
      "exec",
    ];
    if (options.kind === "repair" && options.sessionId) {
      const args = [
        ...common,
        "resume",
        "--json",
        "--output-schema",
        options.schemaPath,
        "--output-last-message",
        output,
        ...(model ? ["--model", model] : []),
        ...(ignoreUserConfig ? ["--ignore-user-config"] : []),
        options.sessionId,
        "-",
      ];
      return {
        command: { program: this.binary(), args, cwd: options.workspacePath, timeoutSeconds: 3600 },
        stdin: options.prompt,
        structuredOutputPath: output,
      };
    }
    const args = [
      ...common,
      "--json",
      "--output-schema",
      options.schemaPath,
      "--output-last-message",
      output,
      ...(model ? ["--model", model] : []),
      ...(ignoreUserConfig ? ["--ignore-user-config"] : []),
      "-",
    ];
    return {
      command: { program: this.binary(), args, cwd: options.workspacePath, timeoutSeconds: options.kind === "review" ? 1800 : 3600 },
      stdin: options.prompt,
      structuredOutputPath: output,
    };
  }

  extractSessionId(stdoutPath: string): string | undefined {
    const lines = readFileSync(stdoutPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as unknown;
        const found = findStringKey(value, new Set(["thread_id", "session_id", "threadId", "sessionId"]));
        if (found) return found;
      } catch {
        // JSONL may contain non-JSON diagnostic lines; ignore them.
      }
    }
    return undefined;
  }
}

class BridgeAdapter extends BaseAdapter {
  constructor(private readonly agent: Agent, private readonly runtime: "kimi" | "deepseek_harness") { super(); }

  private binary(): string {
    if (this.runtime === "kimi") {
      return String(this.agent.config.binary ?? discoverExecutable("kimi") ?? "kimi");
    }
    let shipped: string | undefined;
    try { shipped = require.resolve("@deepseek-ai/dsh-sdk-jsonrpc-demo/bin"); } catch { /* Reported by the structured probe. */ }
    return String(this.agent.config.command ?? shipped ?? discoverExecutable("dsh-jsonrpc-agent") ?? "dsh-jsonrpc-agent");
  }

  private dshConfig(kind: InvocationKind): string {
    const configured = kind === "review" ? this.agent.config.reviewConfig : this.agent.config.executorConfig;
    if (typeof configured === "string") return configured;
    const filename = `${kind === "review" ? "reviewer" : "executor"}.cordis.yml`;
    const candidates = [
      fileURLToPath(new URL(`../../../runtime/dsh/${filename}`, import.meta.url)),
      fileURLToPath(new URL(`../../runtime/dsh/${filename}`, import.meta.url)),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  }

  async probe(): Promise<RuntimeProbeResult> {
    if (this.runtime === "deepseek_harness") {
      return await probeDeepSeekHarness({
        command: this.binary(),
        configs: [this.dshConfig("execute"), this.dshConfig("review")],
        ...(typeof this.agent.config.cwd === "string" ? { workspace: this.agent.config.cwd } : {}),
        ...(typeof this.agent.config.dshHome === "string" ? { dshHome: this.agent.config.dshHome } : {}),
        requestedPackageVersion: this.agent.config.packageVersion ?? this.agent.config.protocolVersion,
      });
    }
    if (this.agent.config.probeProgram === undefined && this.agent.config.probeArgs === undefined) {
      return await probeKimi(
        this.binary(),
        process.cwd(),
        this.agent.config.transport === "agent_sdk_wire" ? "agent_sdk_wire" : "acp",
      );
    }
    const program = String(this.agent.config.probeProgram ?? this.binary());
    const args = Array.isArray(this.agent.config.probeArgs)
      ? this.agent.config.probeArgs.map(String)
      : ["--version"];
    try {
      const result = await execCommand({ program, args, timeoutSeconds: 15 });
      const detail = result.stdout.trim() || result.stderr.trim();
      return { ok: result.exitCode === 0, detail, ...(result.exitCode === 0 ? { version: detail } : {}) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  invocation(options: InvocationOptions): AgentInvocation {
    const output = join(options.runDir, `${options.kind}-result-${Date.now()}.json`);
    const bridge = fileURLToPath(new URL("../runtime-bridge.js", import.meta.url));
    const outputSchema = readFileSync(options.schemaPath, "utf8");
    const prompt = [
      options.prompt,
      "--- AEC-S CONTROL OUTPUT CONTRACT ---",
      outputSchema,
      "--- END AEC-S CONTROL OUTPUT CONTRACT ---",
      "Return exactly one JSON object conforming to that Schema. Do not rename fields, add wrapper objects, add fields, or use alternate verdict values.",
    ].join("\n");
    const kimiShareDir = typeof this.agent.config.shareDir === "string"
      ? this.agent.config.shareDir
      : this.runtime === "kimi" ? discoverKimiShareDirectory(this.binary()) : undefined;
    const safeConfig = this.runtime === "kimi"
      ? {
          binary: this.binary(),
          ...(kimiShareDir ? { shareDir: kimiShareDir } : {}),
          ...(typeof this.agent.config.model === "string" ? { model: this.agent.config.model } : {}),
          ...(typeof this.agent.config.agentFile === "string" ? { agentFile: this.agent.config.agentFile } : {}),
          ...(typeof this.agent.config.reviewAgentFile === "string" ? { reviewAgentFile: this.agent.config.reviewAgentFile } : {}),
          ...(typeof this.agent.config.transport === "string" ? { transport: this.agent.config.transport } : { transport: "acp" }),
          ...(typeof this.agent.config.thinkingLevel === "string" ? { thinkingLevel: this.agent.config.thinkingLevel } : {}),
          thinking: this.agent.config.thinking !== false,
        }
      : {
          command: this.binary(),
          args: Array.isArray(this.agent.config.args) ? this.agent.config.args.map(String) : [this.dshConfig(options.kind)],
          ...(typeof this.agent.config.reviewCommand === "string" ? { reviewCommand: this.agent.config.reviewCommand } : {}),
          ...(Array.isArray(this.agent.config.reviewArgs)
            ? { reviewArgs: this.agent.config.reviewArgs.map(String) }
            : { reviewArgs: [this.dshConfig("review")] }),
          ...(typeof this.agent.config.cwd === "string" ? { cwd: this.agent.config.cwd } : {}),
          ...(typeof this.agent.config.dshHome === "string" ? { dshHome: this.agent.config.dshHome } : {}),
          ...(typeof this.agent.config.provider === "string" ? { provider: this.agent.config.provider } : {}),
          ...(typeof this.agent.config.model === "string" ? { model: this.agent.config.model } : {}),
          ...(typeof this.agent.config.maxTokens === "number" ? { maxTokens: this.agent.config.maxTokens } : {}),
        };
    return {
      command: {
        program: process.execPath,
        args: [bridge, this.runtime, options.kind, options.workspacePath, output, options.sessionId ?? "",
          Buffer.from(JSON.stringify(safeConfig)).toString("base64url")],
        cwd: options.workspacePath,
        timeoutSeconds: options.kind === "review" ? 1800 : 3600,
      },
      stdin: prompt,
      structuredOutputPath: output,
    };
  }

  extractSessionId(stdoutPath: string): string | undefined {
    return extractJsonlField(stdoutPath, new Set(["runtime_session_id", "session_id", "sessionId"]));
  }

  extractRuntimeVersion(stdoutPath: string): string | undefined {
    return extractJsonlField(stdoutPath, new Set(["runtime_version"])) ?? this.agent.runtimeVersion;
  }

  extractTokenUsage(stdoutPath: string): { input?: number; output?: number; total?: number } | undefined {
    const value = extractJsonlValue(stdoutPath, "token_usage");
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.input === "number" ? { input: record.input } : {}),
      ...(typeof record.output === "number" ? { output: record.output } : {}),
      ...(typeof record.total === "number" ? { total: record.total } : {}),
    };
  }
}

function findStringKey(value: unknown, keys: Set<string>): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findStringKey(child, keys);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string") return child;
    const found = findStringKey(child, keys);
    if (found) return found;
  }
  return undefined;
}

function extractJsonlField(path: string, keys: Set<string>): string | undefined {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const found = findStringKey(JSON.parse(line) as unknown, keys);
      if (found) return found;
    } catch {
      // Runtime diagnostics may share stdout; only JSON metadata is authoritative.
    }
  }
  return undefined;
}

function extractJsonlValue(path: string, key: string): unknown {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (Object.hasOwn(value, key)) return value[key];
    } catch {
      // Ignore bounded diagnostics that share stdout.
    }
  }
  return undefined;
}

export function adapterFor(agent: Agent): AgentAdapter {
  if (agent.adapter === "codex") return new CodexAdapter(agent);
  if (agent.adapter === "kimi") return new BridgeAdapter(agent, "kimi");
  if (agent.adapter === "deepseek_harness") return new BridgeAdapter(agent, "deepseek_harness");
  return new CommandAdapter(agent);
}
