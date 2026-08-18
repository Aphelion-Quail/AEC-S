import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { redactText } from "./redaction.js";

export const KIMI_ACP_CLIENT_VERSION = "0.23.0";

export type KimiAcpProbe = {
  protocolVersion: number;
  agentName: string;
  agentVersion: string;
  loadSession: boolean;
  resumeSession: boolean;
  cancel: true;
  stream: true;
  reviewMode: true;
  structuredOutput: true;
};

export type KimiAcpRunResult = {
  text: string;
  sessionId: string;
  usage?: { input?: number; output?: number; total?: number };
  transport: "acp";
  runtimeVersion: string;
  protocolVersion: number;
  permissionSummary: {
    requested: number;
    allowedOnce: number;
    rejected: number;
    toolKinds: string[];
  };
};

export class KimiAcpTransportError extends Error {
  constructor(message: string, readonly turnStarted: boolean) {
    super(message);
    this.name = "KimiAcpTransportError";
  }
}

type KimiAcpOptions = {
  binary: string;
  workspace: string;
  shareDir?: string;
  timeoutMs?: number;
};

type SessionSetup = acp.NewSessionResponse | acp.ResumeSessionResponse | acp.LoadSessionResponse;

function errorText(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 2_000);
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedStderr(child: ChildProcessWithoutNullStreams): () => string {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  return () => redactText(stderr.trim(), 2_000);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, 1_000);
      timer.unref();
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function launch(
  options: KimiAcpOptions,
  client: acp.Client,
): { child: ChildProcessWithoutNullStreams; connection: acp.ClientSideConnection; stderr: () => string } {
  const child = spawn(options.binary, ["acp"], {
    cwd: options.workspace,
    env: {
      ...process.env,
      ...(options.shareDir ? { KIMI_SHARE_DIR: options.shareDir } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new acp.ClientSideConnection(() => client, stream);
  return { child, connection, stderr: boundedStderr(child) };
}

async function initialize(
  connection: acp.ClientSideConnection,
  timeoutMs: number,
): Promise<acp.InitializeResponse> {
  const initialized = await within(connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "aec-s", version: "1.0-runtime" },
    // AEC-S deliberately does not delegate its filesystem or terminal interfaces.
    clientCapabilities: {},
  }), timeoutMs, "Kimi ACP initialize");
  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(`Kimi ACP negotiated unsupported protocol ${initialized.protocolVersion}; expected ${acp.PROTOCOL_VERSION}`);
  }
  return initialized;
}

function modeIds(setup: SessionSetup): Set<string> {
  return new Set(setup.modes?.availableModes.map((mode) => mode.id) ?? []);
}

function requireCapabilities(initialized: acp.InitializeResponse, setup: SessionSetup): KimiAcpProbe {
  const capabilities = initialized.agentCapabilities;
  const modes = modeIds(setup);
  const missing: string[] = [];
  if (!capabilities?.loadSession && capabilities?.sessionCapabilities?.resume == null) missing.push("session load/resume");
  if (capabilities?.sessionCapabilities?.close == null) missing.push("session close");
  if (!modes.has("plan")) missing.push("read-only plan mode");
  if (!modes.has("auto")) missing.push("controlled auto mode");
  if (missing.length > 0) throw new Error(`Kimi ACP lacks required AEC-S capabilities: ${missing.join(", ")}`);
  return {
    protocolVersion: initialized.protocolVersion,
    agentName: initialized.agentInfo?.name ?? "Kimi Code CLI",
    agentVersion: initialized.agentInfo?.version ?? "unknown",
    loadSession: capabilities?.loadSession === true,
    resumeSession: capabilities?.sessionCapabilities?.resume != null,
    cancel: true,
    stream: true,
    reviewMode: true,
    structuredOutput: true,
  };
}

const quietClient: acp.Client = {
  async requestPermission() { return { outcome: { outcome: "cancelled" } }; },
  async sessionUpdate() { /* Capability probing does not execute a turn. */ },
};

export async function probeKimiAcp(options: KimiAcpOptions): Promise<KimiAcpProbe> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const runtime = launch(options, quietClient);
  try {
    const initialized = await initialize(runtime.connection, timeoutMs);
    const session = await within(runtime.connection.newSession({
      cwd: options.workspace,
      mcpServers: [],
    }), timeoutMs, "Kimi ACP session/new");
    const result = requireCapabilities(initialized, session);
    const lifecycle = initialized.agentCapabilities?.sessionCapabilities;
    if (lifecycle?.delete != null) {
      await within(runtime.connection.unstable_deleteSession({ sessionId: session.sessionId }), timeoutMs, "Kimi ACP session/delete");
    } else if (lifecycle?.close != null) {
      await within(runtime.connection.closeSession({ sessionId: session.sessionId }), timeoutMs, "Kimi ACP session/close");
    }
    return result;
  } catch (error) {
    const stderr = runtime.stderr();
    throw new Error(`${errorText(error)}${stderr ? `; Kimi ACP stderr: ${stderr}` : ""}`);
  } finally {
    await stopChild(runtime.child);
  }
}

function pathInsideWorkspace(path: string, workspace: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  const roots = new Set([resolve(workspace), realpathSync.native(resolve(workspace))]);
  return [...roots].some((root) => {
    const relation = relative(root, resolve(root, path));
    return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/") && !relation.startsWith("\\"));
  });
}

function usage(value: acp.Usage | null | undefined): KimiAcpRunResult["usage"] {
  if (!value) return undefined;
  return { input: value.inputTokens, output: value.outputTokens, total: value.totalTokens };
}

function optionValues(option: acp.SessionConfigOption): Set<string> {
  if (option.type !== "select") return new Set();
  const values: string[] = [];
  for (const item of option.options) {
    if ("value" in item) values.push(item.value);
    else values.push(...item.options.map((nested) => nested.value));
  }
  return new Set(values);
}

async function setConfig(
  connection: acp.ClientSideConnection,
  sessionId: string,
  setup: SessionSetup,
  configId: string,
  value: string | undefined,
): Promise<void> {
  if (!value) return;
  const option = setup.configOptions?.find((candidate) => candidate.id === configId);
  if (!option) throw new Error(`Kimi ACP does not expose requested ${configId} configuration`);
  if (option.currentValue === value) return;
  if (option.type === "select" && !optionValues(option).has(value)) {
    throw new Error(`Kimi ACP ${configId} does not support configured value ${value}`);
  }
  await connection.setSessionConfigOption({ sessionId, configId, value });
}

export async function runKimiAcp(options: KimiAcpOptions & {
  prompt: string;
  kind: string;
  sessionId?: string;
  model?: string;
  thinkingLevel?: string;
  agentFile?: string;
  signal?: AbortSignal;
}): Promise<KimiAcpRunResult> {
  const permissionSummary = { requested: 0, allowedOnce: 0, rejected: 0, toolKinds: [] as string[] };
  let text = "";
  let activeSessionId: string | undefined;
  let connection: acp.ClientSideConnection | undefined;
  let turnStarted = false;
  let collecting = false;
  const review = options.kind === "review";
  const client: acp.Client = {
    async requestPermission(params) {
      permissionSummary.requested += 1;
      if (params.toolCall.kind && !permissionSummary.toolKinds.includes(params.toolCall.kind)) {
        permissionSummary.toolKinds.push(params.toolCall.kind);
      }
      const locations = params.toolCall.locations ?? [];
      const locationsAreBounded = locations.length > 0 &&
        locations.every((location) => location.path.length > 0 && pathInsideWorkspace(location.path, options.workspace));
      const allowed = !review && locationsAreBounded
        ? params.options.find((option) => option.kind === "allow_once")
        : undefined;
      if (allowed) {
        permissionSummary.allowedOnce += 1;
        return { outcome: { outcome: "selected", optionId: allowed.optionId } };
      }
      permissionSummary.rejected += 1;
      const rejected = params.options.find((option) => option.kind === "reject_once" || option.kind === "reject_always");
      return rejected
        ? { outcome: { outcome: "selected", optionId: rejected.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      // session/load replays prior conversation updates. Only the new turn is
      // eligible to become the current AEC-S structured result or audit data.
      if (!collecting) return;
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
      if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        && update.kind && !permissionSummary.toolKinds.includes(update.kind)) permissionSummary.toolKinds.push(update.kind);
    },
  };
  const runtime = launch(options, client);
  connection = runtime.connection;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const sent = activeSessionId
      ? connection?.cancel({ sessionId: activeSessionId }).catch(() => undefined)
      : Promise.resolve();
    void sent?.finally(() => {
      const timer = setTimeout(() => { void stopChild(runtime.child); }, 1_000);
      timer.unref();
    });
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (options.agentFile) throw new Error("Kimi ACP does not expose custom agent-file selection; use the explicit legacy transport for this configuration");
    const initialized = await initialize(connection, options.timeoutMs ?? 15_000);
    let setup: SessionSetup;
    if (options.sessionId) {
      // AEC-S restores persisted Runs across ACP subprocess lifetimes. `load`
      // is the durable reconstruction operation; `resume` is the fallback for
      // agents that support continuation without replaying history.
      if (initialized.agentCapabilities?.loadSession) {
        setup = await connection.loadSession({ sessionId: options.sessionId, cwd: options.workspace, mcpServers: [] });
      } else if (initialized.agentCapabilities?.sessionCapabilities?.resume != null) {
        setup = await connection.resumeSession({ sessionId: options.sessionId, cwd: options.workspace, mcpServers: [] });
      } else {
        throw new Error("Kimi ACP cannot resume the persisted Runtime Session");
      }
      activeSessionId = options.sessionId;
    } else {
      const created = await connection.newSession({ cwd: options.workspace, mcpServers: [] });
      setup = created;
      activeSessionId = created.sessionId;
    }
    const capability = requireCapabilities(initialized, setup);
    const mode = review ? "plan" : "auto";
    // Kimi restores the persisted mode during session/load and currently
    // returns an internal error if the client redundantly sets that same mode.
    if (setup.modes?.currentModeId !== mode) {
      await connection.setSessionMode({ sessionId: activeSessionId, modeId: mode });
    }
    await setConfig(connection, activeSessionId, setup, "model", options.model);
    await setConfig(connection, activeSessionId, setup, "thinking", options.thinkingLevel);
    collecting = true;
    turnStarted = true;
    const prompted = await connection.prompt({
      sessionId: activeSessionId,
      prompt: [{ type: "text", text: options.prompt }],
    });
    if (prompted.stopReason !== "end_turn") throw new Error(`Kimi ACP turn ended with ${prompted.stopReason}`);
    const promptUsage = usage(prompted.usage);
    return {
      text,
      sessionId: activeSessionId,
      ...(promptUsage ? { usage: promptUsage } : {}),
      transport: "acp",
      runtimeVersion: capability.agentVersion,
      protocolVersion: capability.protocolVersion,
      permissionSummary,
    };
  } catch (error) {
    const stderr = runtime.stderr();
    throw new KimiAcpTransportError(
      `${errorText(error)}${stderr ? `; Kimi ACP stderr: ${stderr}` : ""}`,
      turnStarted,
    );
  } finally {
    options.signal?.removeEventListener("abort", stop);
    if (activeSessionId && !connection.signal.aborted) {
      await within(
        connection.closeSession({ sessionId: activeSessionId }),
        5_000,
        "Kimi ACP session/close",
      ).catch(() => undefined);
    }
    await stopChild(runtime.child);
  }
}
