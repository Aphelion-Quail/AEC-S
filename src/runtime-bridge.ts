#!/usr/bin/env node
import { createSession, type Session, type Turn } from "@moonshot-ai/kimi-agent-sdk";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { writeJsonAtomic } from "./files.js";
import { dirname, join } from "node:path";
import { runKimiAcp } from "./kimi-acp.js";

type BridgeConfig = {
  binary?: string;
  model?: string;
  thinking?: boolean;
  thinkingLevel?: string;
  transport?: "acp" | "agent_sdk_wire";
  agentFile?: string;
  reviewAgentFile?: string;
  shareDir?: string;
  command?: string;
  args?: string[];
  reviewCommand?: string;
  reviewArgs?: string[];
  cwd?: string;
  dshHome?: string;
  provider?: string;
  maxTokens?: number;
};

type TokenUsage = { input?: number; output?: number; total?: number };

function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.token_usage && typeof record.token_usage === "object"
    ? record.token_usage as Record<string, unknown>
    : record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : record;
  const input = Number(candidate.input_tokens ?? candidate.inputTokens ?? candidate.promptTokens);
  const output = Number(candidate.output_tokens ?? candidate.outputTokens ?? candidate.completionTokens);
  const total = Number(candidate.total_tokens ?? candidate.totalTokens);
  if ([input, output, total].every((number) => !Number.isFinite(number))) return undefined;
  return {
    ...(Number.isFinite(input) ? { input } : {}),
    ...(Number.isFinite(output) ? { output } : {}),
    ...(Number.isFinite(total) ? { total } : Number.isFinite(input) && Number.isFinite(output) ? { total: input + output } : {}),
  };
}

function decodeConfig(value: string | undefined): BridgeConfig {
  if (!value) return {};
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as BridgeConfig;
}

function structured(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]?.trim() ?? "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Try the next bounded representation of the final response.
    }
  }
  throw new Error("Runtime final response did not contain one JSON object");
}

async function runLegacyKimi(
  prompt: string,
  kind: string,
  workspace: string,
  sessionId: string | undefined,
  config: BridgeConfig,
): Promise<{ value: unknown; sessionId: string; usage?: TokenUsage }> {
  const session: Session = createSession({
    workDir: workspace,
    ...(sessionId ? { sessionId } : {}),
    ...(config.model ? { model: config.model } : {}),
    thinking: config.thinking ?? true,
    yoloMode: kind !== "review",
    ...(config.binary ? { executable: config.binary } : {}),
    ...(config.shareDir ? { shareDir: config.shareDir } : {}),
    ...(kind === "review" && config.reviewAgentFile
      ? { agentFile: config.reviewAgentFile }
      : config.agentFile ? { agentFile: config.agentFile } : {}),
    clientInfo: { name: "aec-s", version: "1.0-runtime" },
  });
  let turn: Turn | undefined;
  const stop = () => { if (turn) void turn.interrupt(); void session.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    if (kind === "review") await session.setPlanMode(true);
    turn = session.prompt(prompt);
    let text = "";
    let usage: TokenUsage | undefined;
    for await (const event of turn) {
      if ("payload" in event) usage = tokenUsage(event.payload) ?? usage;
      if (event.type === "ContentPart" && event.payload && typeof event.payload === "object") {
        const part = event.payload as { type?: unknown; text?: unknown };
        if (part.type === "text" && typeof part.text === "string") text += part.text;
      }
    }
    const result = await turn.result;
    if (result.status !== "finished") throw new Error(`Kimi turn ended with ${result.status}`);
    return { value: structured(text), sessionId: session.sessionId, ...(usage ? { usage } : {}) };
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await session.close();
  }
}

async function runKimi(
  prompt: string,
  kind: string,
  workspace: string,
  sessionId: string | undefined,
  config: BridgeConfig,
): Promise<{
  value: unknown;
  sessionId: string;
  usage?: TokenUsage;
  transport: "acp" | "agent_sdk_wire";
  runtimeVersion?: string;
  protocolVersion?: number | string;
  permissionSummary?: { requested: number; allowedOnce: number; rejected: number; toolKinds: string[] };
}> {
  const transport = config.transport ?? "acp";
  if (transport !== "agent_sdk_wire") {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    try {
      const result = await runKimiAcp({
        binary: config.binary ?? "kimi",
        workspace,
        prompt,
        kind,
        ...(sessionId ? { sessionId } : {}),
        ...(config.shareDir ? { shareDir: config.shareDir } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : config.thinking === false ? { thinkingLevel: "low" } : {}),
        ...(kind === "review" && config.reviewAgentFile
          ? { agentFile: config.reviewAgentFile }
          : config.agentFile ? { agentFile: config.agentFile } : {}),
        signal: cancellation.signal,
      });
      return {
        value: structured(result.text),
        sessionId: result.sessionId,
        ...(result.usage ? { usage: result.usage } : {}),
        transport: "acp",
        runtimeVersion: result.runtimeVersion,
        protocolVersion: result.protocolVersion,
        permissionSummary: result.permissionSummary,
      };
    } finally {
      process.off("SIGTERM", abort);
      process.off("SIGINT", abort);
    }
  }
  const legacy = await runLegacyKimi(prompt, kind, workspace, sessionId, config);
  return { ...legacy, transport: "agent_sdk_wire" };
}

async function runDeepSeek(
  prompt: string,
  kind: string,
  workspace: string,
  sessionId: string | undefined,
  config: BridgeConfig,
  stateRoot: string,
): Promise<{ value: unknown; sessionId: string; usage?: TokenUsage }> {
  const command = kind === "review" ? config.reviewCommand ?? config.command ?? "dsh-jsonrpc-agent" : config.command ?? "dsh-jsonrpc-agent";
  const harness = new DeepSeekHarness({
    launch: {
      command,
      args: kind === "review" ? config.reviewArgs ?? config.args ?? [] : config.args ?? [],
      cwd: config.cwd ?? workspace,
      env: {
        ...process.env,
        DSH_CWD: workspace,
        DSH_SESSION_ROOT: join(stateRoot, "dsh-sessions"),
        ...(config.dshHome ? { DSH_HOME: config.dshHome } : {}),
      },
    },
    cwd: workspace,
    provider: config.provider ?? "deepseek-official",
    ...(config.model ? { model: config.model } : {}),
    ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
  });
  const stop = () => { void harness.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const result = await harness.run(prompt, sessionId ? { sessionId } : {});
    const usages = result.events.map((event) => tokenUsage(event)).filter((value): value is TokenUsage => Boolean(value));
    const usage = usages.length > 0 ? usages.reduce<TokenUsage>((sum, value) => ({
      input: (sum.input ?? 0) + (value.input ?? 0),
      output: (sum.output ?? 0) + (value.output ?? 0),
      total: (sum.total ?? 0) + (value.total ?? 0),
    }), {}) : undefined;
    return { value: structured(result.finalResponse), sessionId: result.sessionId, ...(usage ? { usage } : {}) };
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await harness.close();
  }
}

async function main(): Promise<void> {
  const [runtime, kind, workspace, output, sessionId, encodedConfig] = process.argv.slice(2);
  if (!runtime || !kind || !workspace || !output) {
    throw new Error("Usage: runtime-bridge <kimi|deepseek_harness> <kind> <workspace> <output> [session] [config]");
  }
  let prompt = "";
  for await (const chunk of process.stdin) prompt += String(chunk);
  const config = decodeConfig(encodedConfig);
  const result = runtime === "kimi"
    ? await runKimi(prompt, kind, workspace, sessionId || undefined, config)
    : runtime === "deepseek_harness"
      ? await runDeepSeek(prompt, kind, workspace, sessionId || undefined, config, dirname(output))
      : undefined;
  if (!result) throw new Error(`Unsupported runtime bridge: ${runtime}`);
  writeJsonAtomic(output, result.value);
  const kimiResult = runtime === "kimi" ? result as Awaited<ReturnType<typeof runKimi>> : undefined;
  const kimiMetadata = kimiResult ? {
    runtime_transport: kimiResult.transport,
    ...(kimiResult.runtimeVersion ? { runtime_version: kimiResult.runtimeVersion } : {}),
    ...(kimiResult.protocolVersion ? { runtime_protocol_version: kimiResult.protocolVersion } : {}),
    ...(kimiResult.permissionSummary ? { permission_summary: kimiResult.permissionSummary } : {}),
  } : {};
  process.stdout.write(`${JSON.stringify({
    runtime_session_id: result.sessionId,
    runtime,
    ...(result.usage ? { token_usage: result.usage } : {}),
    ...kimiMetadata,
  })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
