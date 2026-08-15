import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AecDatabase } from "./db.js";
import { AecEngine } from "./engine.js";
import type { DecisionInput, TaskInput } from "./types.js";

function result(value: unknown) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: object,
  };
}

export async function serveMcp(db: AecDatabase): Promise<void> {
  const engine = new AecEngine(db);
  const server = new McpServer({ name: "aec-core", version: "0.1.0" });

  server.registerTool(
    "aec_status",
    {
      description: "Read AEC project, task, run, agent, workspace, decision, and recent event state.",
      inputSchema: z.object({ projectId: z.string().optional() }),
    },
    async ({ projectId }) => result(db.statusSnapshot(projectId)),
  );

  server.registerTool(
    "aec_submit_task_graph",
    {
      description: "Submit an immutable structured Task DAG to AEC.",
      inputSchema: z.object({ projectId: z.string(), tasks: z.array(z.record(z.string(), z.unknown())).min(1) }),
    },
    async ({ projectId, tasks }) => result({ tasks: engine.submitGraph(projectId, tasks as unknown as TaskInput[]) }),
  );

  server.registerTool(
    "aec_apply_directive",
    {
      description: "Apply a structured pause, resume, reprioritize, or cancel directive.",
      inputSchema: z.object({
        action: z.enum(["pause", "resume", "reprioritize", "cancel"]),
        projectId: z.string().optional(),
        taskIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
      }),
    },
    async (input) => result({ tasks: engine.applyDirective(input) }),
  );

  server.registerTool(
    "aec_list_decisions",
    {
      description: "List pending or resolved AEC decisions and Human escalations.",
      inputSchema: z.object({ projectId: z.string().optional(), status: z.enum(["pending", "resolved"]).optional() }),
    },
    async ({ projectId, status }) => result({ decisions: db.listDecisions(projectId, status) }),
  );

  server.registerTool(
    "aec_resolve_decision",
    {
      description: "Persist a Human resolution and apply its requested task action.",
      inputSchema: z.object({ decisionId: z.string(), resolution: z.record(z.string(), z.unknown()) }),
    },
    async ({ decisionId, resolution }) => result({ decision: engine.resolveDecision(decisionId, resolution) }),
  );

  server.registerTool(
    "aec_record_decision",
    {
      description: "Record a durable project or task decision through AEC Core.",
      inputSchema: z.object({
        projectId: z.string(),
        taskId: z.string().optional(),
        kind: z.enum(["architecture", "product", "tradeoff", "record"]),
        title: z.string().min(1),
        body: z.string().min(1),
      }),
    },
    async (input) => result({ decision: db.createDecision({ ...input, status: "resolved" } as DecisionInput) }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
