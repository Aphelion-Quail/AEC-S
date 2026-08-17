import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { builtCliPath, tempDir } from "./helpers.js";
import { AecSDatabase } from "../src/db.js";
import { createGitRepository } from "./helpers.js";
import { aecSVersion } from "../src/version.js";
import { mcpHttpPort, serveMcpHttp } from "../src/mcp.js";

test("exposes the six AEC-S MCP tools over stdio", async () => {
  const home = tempDir("aec-s-mcp-");
  const db = new AecSDatabase(home);
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
    env: { AEC_S_HOME: home, PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "aec-s-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.deepEqual(client.getServerVersion(), { name: "aec-s-core", version: aecSVersion() });
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "aec_s_apply_directive",
      "aec_s_list_decisions",
      "aec_s_record_decision",
      "aec_s_resolve_decision",
      "aec_s_status",
      "aec_s_submit_task_graph",
    ]);
    for (const tool of tools.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} must expose an object input schema`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown input fields`);
    }
    const graphTool = tools.tools.find((tool) => tool.name === "aec_s_submit_task_graph")!;
    assert.deepEqual(graphTool.inputSchema.required, ["projectId", "tasks"]);
    const graphProperties = graphTool.inputSchema.properties as Record<string, { minItems?: number }>;
    assert.equal(graphProperties.tasks!.minItems, 1);
    const resolveTool = tools.tools.find((tool) => tool.name === "aec_s_resolve_decision")!;
    assert.deepEqual(resolveTool.inputSchema.required, ["decisionId", "resolution"]);
    const status = await client.callTool({ name: "aec_s_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const graph = await client.callTool({
      name: "aec_s_submit_task_graph",
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
      name: "aec_s_apply_directive",
      arguments: { action: "pause", taskIds: ["mcp-task"] },
    });
    assert.equal(paused.isError, undefined);
    const recorded = await client.callTool({
      name: "aec_s_record_decision",
      arguments: {
        projectId: project.id,
        kind: "record",
        title: "MCP decision",
        body: "Recorded through the control plane",
      },
    });
    assert.equal(recorded.isError, undefined);
    const decisions = await client.callTool({
      name: "aec_s_list_decisions",
      arguments: { projectId: project.id },
    });
    assert.equal(decisions.isError, undefined);
    const resolved = await client.callTool({
      name: "aec_s_resolve_decision",
      arguments: { decisionId: pendingDecision.id, resolution: { answer: "Core owns state" } },
    });
    assert.equal(resolved.isError, undefined);
    const invalid = await client.callTool({
      name: "aec_s_submit_task_graph",
      arguments: { projectId: project.id, tasks: [{ title: "invalid" }] },
    });
    assert.equal(invalid.isError, true);
    const unsafeId = await client.callTool({ name: "aec_s_status", arguments: { projectId: "../outside" } });
    assert.equal(unsafeId.isError, true);
    const unscopedDirective = await client.callTool({
      name: "aec_s_apply_directive",
      arguments: { action: "pause" },
    });
    assert.equal(unscopedDirective.isError, true);
  } finally {
    await client.close();
  }
});

test("exposes AEC-S MCP over loopback Streamable HTTP", async () => {
  const home = tempDir("aec-s-mcp-http-");
  const db = new AecSDatabase(home);
  db.createProject({ id: "mcp-http-project", name: "MCP HTTP", repoPath: createGitRepository() });
  const controller = new AbortController();
  let resolveUrl!: (url: string) => void;
  const listening = new Promise<string>((resolve) => { resolveUrl = resolve; });
  const serving = serveMcpHttp(db, {
    port: 0,
    signal: controller.signal,
    onListening: resolveUrl,
  });
  const url = await listening;
  const client = new Client({ name: "aec-s-http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    assert.deepEqual(client.getServerVersion(), { name: "aec-s-core", version: aecSVersion() });
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
    const status = await client.callTool({ name: "aec_s_status", arguments: { projectId: "mcp-http-project" } });
    assert.equal(status.isError, undefined);
    const health = await fetch(url.replace("/mcp", "/healthz"));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "aec-s-mcp", version: aecSVersion() });
    const unsupported = await fetch(url);
    assert.equal(unsupported.status, 405);
  } finally {
    await client.close();
    controller.abort();
    await serving;
    db.close();
  }
});

test("validates the configured MCP HTTP port", () => {
  assert.equal(mcpHttpPort(undefined), 7337);
  assert.equal(mcpHttpPort("7447"), 7447);
  assert.throws(() => mcpHttpPort("0"), /between 1 and 65535/);
  assert.throws(() => mcpHttpPort("not-a-port"), /between 1 and 65535/);
});
