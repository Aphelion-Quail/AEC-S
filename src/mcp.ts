import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { z } from "zod";
import type { AecSDatabase } from "./db.js";
import { AecSEngine } from "./engine.js";
import { decisionInputSchema, directiveSchema, idSchema, resolutionSchema, taskInputSchema } from "./input.js";
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

function createAecSMcpServer(db: AecSDatabase): McpServer {
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

  return server;
}

export async function serveMcp(db: AecSDatabase): Promise<void> {
  const server = createAecSMcpServer(db);
  await server.connect(new StdioServerTransport());
}

export type McpHttpOptions = {
  port?: number;
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
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid MCP HTTP port: ${port}`);
  }
  const app = createMcpExpressApp({ host: MCP_HTTP_HOST });

  app.get("/healthz", (_request: IncomingMessage, response: ServerResponse) => {
    jsonResponse(response, 200, { status: "ok", service: "aec-s-mcp", version: aecSVersion() });
  });
  app.post("/mcp", async (request: ParsedHttpRequest, response: ServerResponse) => {
    const server = createAecSMcpServer(db);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await transport.close();
      await server.close();
    };
    response.on("close", () => void close());
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      await close();
      if (!response.headersSent) {
        jsonResponse(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  app.all("/mcp", (_request: IncomingMessage, response: ServerResponse) => {
    jsonResponse(response, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  await new Promise<void>((resolve, reject) => {
    let httpServer: HttpServer | undefined;
    const stop = () => {
      if (!httpServer) return resolve();
      httpServer.close((error) => error ? reject(error) : resolve());
    };
    if (options.signal?.aborted) return resolve();
    const createdServer = app.listen(port, MCP_HTTP_HOST, () => {
      const address = createdServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      options.onListening?.(`http://${MCP_HTTP_HOST}:${actualPort}/mcp`);
    });
    httpServer = createdServer;
    createdServer.on("error", reject);
    options.signal?.addEventListener("abort", stop, { once: true });
  });
}
