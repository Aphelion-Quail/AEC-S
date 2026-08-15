import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Agent, CommandSpec } from "../types.js";
import { execCommand } from "../exec.js";

export type InvocationKind = "execute" | "repair" | "review";

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
  healthcheck(): Promise<{ ok: boolean; detail: string }>;
  invocation(options: InvocationOptions): AgentInvocation;
  extractSessionId(stdoutPath: string): string | undefined;
}

function substitute(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => replacements[key] ?? `{${key}}`);
}

class CommandAdapter implements AgentAdapter {
  constructor(private readonly agent: Agent) {}

  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    const binary = String(this.agent.config.binary ?? "");
    if (!binary) return { ok: false, detail: "command adapter config.binary is required" };
    const result = await execCommand({ program: binary, args: ["--version"], timeoutSeconds: 10 });
    return { ok: result.exitCode === 0, detail: result.stdout.trim() || result.stderr.trim() };
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

class CodexAdapter implements AgentAdapter {
  constructor(private readonly agent: Agent) {}

  private binary(): string {
    return String(this.agent.config.binary ?? "codex");
  }

  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    const result = await execCommand({ program: this.binary(), args: ["--version"], timeoutSeconds: 10 });
    return { ok: result.exitCode === 0, detail: result.stdout.trim() || result.stderr.trim() };
  }

  invocation(options: InvocationOptions): AgentInvocation {
    const output = join(options.runDir, `${options.kind}-result-${Date.now()}.json`);
    const model = typeof this.agent.config.model === "string" ? this.agent.config.model : undefined;
    const ignoreUserConfig = this.agent.config.ignoreUserConfig === true;
    const common = ["--ask-for-approval", "never", "exec"];
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
    const sandbox = options.kind === "review" ? "read-only" : "workspace-write";
    const args = [
      ...common,
      "--json",
      "--sandbox",
      sandbox,
      "--output-schema",
      options.schemaPath,
      "--output-last-message",
      output,
      "--cd",
      options.workspacePath,
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

export function adapterFor(agent: Agent): AgentAdapter {
  if (agent.adapter === "codex") return new CodexAdapter(agent);
  return new CommandAdapter(agent);
}
