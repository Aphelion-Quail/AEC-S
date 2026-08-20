import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AecSDatabase } from "./db.js";
import { AecSEngine } from "./engine.js";
import { decisionInputSchema, directiveSchema, idSchema, repoGlobSchema, resolutionSchema, taskInputSchema } from "./input.js";
import { readMcpHttpToken } from "./paths.js";
import { aecSVersion } from "./version.js";

const MCP_HTTP_HOST = "127.0.0.1";
const DEFAULT_MCP_HTTP_PORT = 7337;
type ParsedHttpRequest = IncomingMessage & { body?: unknown };

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function result(value: unknown) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: object,
  };
}

function createAecSMcpServer(db: AecSDatabase, actorAgentId = process.env.AEC_S_MCP_ACTOR_AGENT_ID?.trim()): McpServer {
  const engine = new AecSEngine(db);
  const server = new McpServer({ name: "aec-s-core", version: aecSVersion() });

  server.registerTool(
    "aec_s_status",
    {
      description: "Read AEC-S project, task, run, agent, workspace, decision, and recent event state.",
      inputSchema: z.object({ projectId: idSchema.optional() }).strict(),
    },
    async ({ projectId }) => result(db.statusSnapshot(projectId)),
  );

  server.registerTool(
    "aec_s_submit_task_graph",
    {
      description: "Submit an immutable structured Task DAG to AEC-S.",
      inputSchema: z.object({ projectId: idSchema, tasks: z.array(taskInputSchema).min(1) }).strict(),
    },
    async ({ projectId, tasks }) => result({ tasks: engine.submitGraph(projectId, tasks) }),
  );

  server.registerTool(
    "aec_s_apply_directive",
    {
      description: "Apply a structured pause, resume, reprioritize, or cancel directive.",
      inputSchema: directiveSchema,
    },
    async (input) => result({ tasks: engine.applyDirective(input) }),
  );

  server.registerTool(
    "aec_s_list_decisions",
    {
      description: "List pending or resolved AEC-S decisions and Human escalations.",
      inputSchema: z.object({ projectId: idSchema.optional(), status: z.enum(["pending", "resolved"]).optional() }).strict(),
    },
    async ({ projectId, status }) => result({ decisions: db.listDecisions(projectId, status) }),
  );

  server.registerTool(
    "aec_s_resolve_decision",
    {
      description: "Persist a Human resolution and apply its requested task action.",
      inputSchema: z.object({ decisionId: idSchema, resolution: resolutionSchema }).strict(),
    },
    async ({ decisionId, resolution }) => result({ decision: engine.resolveDecision(decisionId, resolution) }),
  );

  server.registerTool(
    "aec_s_record_decision",
    {
      description: "Record a durable project or task decision through AEC-S Core.",
      inputSchema: decisionInputSchema.omit({ status: true }),
    },
    async (input) => result({ decision: db.createDecision({ ...input, status: "resolved" }) }),
  );

  server.registerTool(
    "aec_s_list_findings",
    {
      description: "List durable review Findings and their evidence state.",
      inputSchema: z.object({
        taskId: idSchema.optional(),
        status: z.enum(["proposed", "structurally_valid", "verified", "dismissed", "resolved"]).optional(),
      }).strict(),
    },
    async ({ taskId, status }) => result({ findings: db.listFindings(taskId, status) }),
  );

  server.registerTool(
    "aec_s_transition_finding",
    {
      description: "Verify, dismiss, or resolve a Finding using explicit evidence.",
      inputSchema: z.object({
        findingId: idSchema,
        status: z.enum(["verified", "dismissed", "resolved"]),
        evidence: z.string().min(1),
      }).strict(),
    },
    async ({ findingId, status, evidence }) => {
      if (!actorAgentId) throw new Error("Finding transitions require a server-bound AEC_S_MCP_ACTOR_AGENT_ID");
      return result({ finding: db.transitionFinding(findingId, status, evidence, actorAgentId) });
    },
  );

  server.registerTool(
    "aec_s_expand_task_scope",
    {
      description: "Create a new immutable Task Revision after deterministic Scope Expansion validation.",
      inputSchema: z.object({
        taskId: idSchema,
        addWriteGlobs: z.array(repoGlobSchema),
        addWatchGlobs: z.array(repoGlobSchema),
        evidence: z.string().min(1),
      }).strict(),
    },
    async ({ taskId, ...proposal }) => result({ revision: db.createScopeExpansionRevision(taskId, proposal) }),
  );

  server.registerTool(
    "aec_s_poll_outbox",
    {
      description: "Poll durable Human-on-Exception messages. Delivery alone does not acknowledge them.",
      inputSchema: z.object({ projectId: idSchema.optional() }).strict(),
    },
    async ({ projectId }) => {
      const messages = db.listOutbox(projectId, true)
        .filter((message) => message.channel === "mcp" && message.status !== "acknowledged")
        .map((message) => message.status === "pending" ? db.markOutboxDelivered(message.id) : message);
      return result({ messages });
    },
  );

  server.registerTool(
    "aec_s_acknowledge_outbox",
    {
      description: "Acknowledge one durable Human-on-Exception message.",
      inputSchema: z.object({ messageId: idSchema }).strict(),
    },
    async ({ messageId }) => result({ message: db.acknowledgeOutbox(messageId) }),
  );

  return server;
}

export async function serveMcp(db: AecSDatabase): Promise<void> {
  const server = createAecSMcpServer(db);
  await server.connect(new StdioServerTransport());
}

export type McpHttpOptions = {
  port?: number;
  /** Test-only: ask the kernel for an ephemeral loopback port. */
  allowEphemeralPort?: boolean;
  token?: string;
  actorAgentId?: string;
  signal?: AbortSignal;
  onListening?: (url: string) => void;
};

export function mcpHttpPort(value = process.env.AEC_S_MCP_HTTP_PORT): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MCP_HTTP_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`AEC_S_MCP_HTTP_PORT must be an integer between 1 and 65535: ${value}`);
  }
  return port;
}

export async function serveMcpHttp(db: AecSDatabase, options: McpHttpOptions = {}): Promise<void> {
  const port = options.port ?? mcpHttpPort();
  if (!Number.isInteger(port) || port < (options.allowEphemeralPort ? 0 : 1) || port > 65_535) {
    throw new Error(`Invalid MCP HTTP port: ${port}`);
  }
  process.env.NODE_ENV ??= "production";
  const app = createMcpExpressApp({ host: MCP_HTTP_HOST });
  const expectedToken = options.token ?? readMcpHttpToken(db.paths);
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; lastUsedAt: number }>();
  const sessionTtlMs = 30 * 60 * 1_000;
  const maxSessions = 64;

  const authorized = (request: IncomingMessage, response: ServerResponse): boolean => {
    const supplied = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expectedToken);
    if (suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)) return true;
    response.setHeader("www-authenticate", "Bearer");
    jsonResponse(response, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return false;
  };

  const sessionFor = (request: IncomingMessage) => {
    const value = request.headers["mcp-session-id"];
    const session = typeof value === "string" ? sessions.get(value) : undefined;
    if (session) session.lastUsedAt = Date.now();
    return session;
  };

  const pruneSessions = async (): Promise<void> => {
    const expired = [...sessions.entries()]
      .filter(([, session]) => Date.now() - session.lastUsedAt > sessionTtlMs)
      .map(([id]) => id);
    while (sessions.size - expired.length >= maxSessions) {
      const oldest = [...sessions.entries()]
        .filter(([id]) => !expired.includes(id))
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) break;
      expired.push(oldest[0]);
    }
    await Promise.allSettled(expired.map(async (id) => {
      const session = sessions.get(id);
      sessions.delete(id);
      if (!session) return;
      await session.transport.close();
      await session.server.close();
    }));
  };
  const pruneTimer = setInterval(() => { void pruneSessions().catch(() => undefined); }, 60_000);
  pruneTimer.unref();

  app.get("/healthz", (_request: IncomingMessage, response: ServerResponse) => {
    jsonResponse(response, 200, { status: "ok", service: "aec-s-mcp" });
  });
  app.post("/mcp", async (request: ParsedHttpRequest, response: ServerResponse) => {
    if (!authorized(request, response)) return;
    try {
      await pruneSessions();
      let session = sessionFor(request);
      if (!session && isInitializeRequest(request.body)) {
        const server = createAecSMcpServer(db, options.actorAgentId);
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => { sessions.set(sessionId, { server, transport, lastUsedAt: Date.now() }); },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        session = { server, transport, lastUsedAt: Date.now() };
      }
      if (!session) {
        jsonResponse(response, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing MCP session" }, id: null });
        return;
      }
      await session.transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        jsonResponse(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  app.get("/mcp", async (request: ParsedHttpRequest, response: ServerResponse) => {
    if (!authorized(request, response)) return;
    const session = sessionFor(request);
    if (!session) return jsonResponse(response, 400, { error: "Invalid or missing MCP session" });
    await session.transport.handleRequest(request, response);
  });
  app.delete("/mcp", async (request: ParsedHttpRequest, response: ServerResponse) => {
    if (!authorized(request, response)) return;
    const session = sessionFor(request);
    if (!session) return jsonResponse(response, 400, { error: "Invalid or missing MCP session" });
    await session.transport.handleRequest(request, response);
  });
  app.all("/mcp", (_request: IncomingMessage, response: ServerResponse) => {
    jsonResponse(response, 405, { error: "Method not allowed" });
  });
  app.use((error: unknown, _request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    if (response.headersSent) return next(error);
    const status = error && typeof error === "object" && "status" in error && Number((error as { status?: unknown }).status) === 413
      ? 413
      : 400;
    jsonResponse(response, status, {
      jsonrpc: "2.0",
      error: { code: status === 413 ? -32002 : -32700, message: status === 413 ? "Request body too large" : "Invalid request body" },
      id: null,
    });
  });

  await new Promise<void>((resolve, reject) => {
    let httpServer: HttpServer | undefined;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(pruneTimer);
      if (!httpServer) return resolve();
      void Promise.allSettled([...sessions.values()].map(async ({ server, transport }) => {
        await transport.close();
        await server.close();
      })).finally(() => {
        const forceClose = setTimeout(() => httpServer?.closeAllConnections(), 1_000);
        forceClose.unref();
        httpServer!.close((error) => {
          clearTimeout(forceClose);
          if (error) reject(error);
          else resolve();
        });
        httpServer!.closeIdleConnections();
      });
    };
    if (options.signal?.aborted) { clearInterval(pruneTimer); return resolve(); }
    const createdServer = app.listen(port, MCP_HTTP_HOST, () => {
      const address = createdServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      options.onListening?.(`http://${MCP_HTTP_HOST}:${actualPort}/mcp`);
    });
    httpServer = createdServer;
    createdServer.on("error", (error: Error) => { clearInterval(pruneTimer); reject(error); });
    options.signal?.addEventListener("abort", stop, { once: true });
  });
}
