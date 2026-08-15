import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { builtCliPath, tempDir } from "./helpers.js";
import { AecDatabase } from "../src/db.js";
import { createGitRepository } from "./helpers.js";
import { aecVersion } from "../src/version.js";

test("exposes the six AEC MCP tools over stdio", async () => {
  const home = tempDir("aec-mcp-");
  const db = new AecDatabase(home);
  const project = db.createProject({ id: "mcp-project", name: "MCP", repoPath: createGitRepository() });
  const pendingDecision = db.createDecision({
    id: "mcp-decision",
    projectId: project.id,
    kind: "architecture",
    title: "Choose ownership",
    body: "Human input required",
  });
  db.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtCliPath(), "mcp"],
    env: { AEC_HOME: home, PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "aec-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.deepEqual(client.getServerVersion(), { name: "aec-core", version: aecVersion() });
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "aec_apply_directive",
      "aec_list_decisions",
      "aec_record_decision",
      "aec_resolve_decision",
      "aec_status",
      "aec_submit_task_graph",
    ]);
    for (const tool of tools.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} must expose an object input schema`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown input fields`);
    }
    const graphTool = tools.tools.find((tool) => tool.name === "aec_submit_task_graph")!;
    assert.deepEqual(graphTool.inputSchema.required, ["projectId", "tasks"]);
    const graphProperties = graphTool.inputSchema.properties as Record<string, { minItems?: number }>;
    assert.equal(graphProperties.tasks!.minItems, 1);
    const resolveTool = tools.tools.find((tool) => tool.name === "aec_resolve_decision")!;
    assert.deepEqual(resolveTool.inputSchema.required, ["decisionId", "resolution"]);
    const status = await client.callTool({ name: "aec_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const graph = await client.callTool({
      name: "aec_submit_task_graph",
      arguments: {
        projectId: project.id,
        tasks: [{
          id: "mcp-task",
          projectId: project.id,
          title: "MCP task",
          goal: "Submit through MCP",
          scope: { writeGlobs: ["mcp.txt"], impactGlobs: [], tags: [] },
          acceptanceCriteria: ["Accepted"],
        }],
      },
    });
    assert.equal(graph.isError, undefined);
    const paused = await client.callTool({
      name: "aec_apply_directive",
      arguments: { action: "pause", taskIds: ["mcp-task"] },
    });
    assert.equal(paused.isError, undefined);
    const recorded = await client.callTool({
      name: "aec_record_decision",
      arguments: {
        projectId: project.id,
        kind: "record",
        title: "MCP decision",
        body: "Recorded through the control plane",
      },
    });
    assert.equal(recorded.isError, undefined);
    const decisions = await client.callTool({
      name: "aec_list_decisions",
      arguments: { projectId: project.id },
    });
    assert.equal(decisions.isError, undefined);
    const resolved = await client.callTool({
      name: "aec_resolve_decision",
      arguments: { decisionId: pendingDecision.id, resolution: { answer: "Core owns state" } },
    });
    assert.equal(resolved.isError, undefined);
    const invalid = await client.callTool({
      name: "aec_submit_task_graph",
      arguments: { projectId: project.id, tasks: [{ title: "invalid" }] },
    });
    assert.equal(invalid.isError, true);
    const unsafeId = await client.callTool({ name: "aec_status", arguments: { projectId: "../outside" } });
    assert.equal(unsafeId.isError, true);
    const unscopedDirective = await client.callTool({
      name: "aec_apply_directive",
      arguments: { action: "pause" },
    });
    assert.equal(unscopedDirective.isError, true);
  } finally {
    await client.close();
  }
});
