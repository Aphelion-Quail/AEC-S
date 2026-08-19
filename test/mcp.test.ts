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
import type { Run } from "../src/types.js";

test("exposes the AEC-S control and evidence tools over stdio", async () => {
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
  const executor = db.createAgent({ id: "mcp-executor", name: "MCP executor", adapter: "command", roles: ["executor"] });
  db.createAgent({ id: "mcp-reviewer", name: "MCP reviewer", adapter: "command", roles: ["reviewer"] });
  const findingTask = db.createTask({
    id: "mcp-finding-task",
    projectId: project.id,
    title: "Finding task",
    goal: "Exercise Finding tools",
    scope: { writeGlobs: ["finding.txt"], watchGlobs: [], tags: [] },
    acceptanceCriteria: ["Finding is governed"],
  });
  const timestamp = new Date().toISOString();
  const findingRun: Run = {
    id: "mcp-finding-run", taskId: findingTask.id, agentId: executor.id, workspaceId: "mcp-finding-workspace",
    phase: "review", status: "interrupted", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base",
    validation: [], effects: {}, logDir: home, startedAt: timestamp, updatedAt: timestamp,
    taskRevisionId: findingTask.currentRevisionId,
  };
  db.createRun(findingRun);
  const seededFinding = db.createFinding({
    projectId: project.id, taskId: findingTask.id, runId: findingRun.id,
    taskRevisionId: findingTask.currentRevisionId!, severity: "blocking", summary: "Reproduce MCP transition",
    reviewerAgentId: "mcp-reviewer",
  });
  db.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtCliPath(), "mcp"],
    env: { AEC_S_HOME: home, AEC_S_MCP_ACTOR_AGENT_ID: "mcp-reviewer", PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "aec-s-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.deepEqual(client.getServerVersion(), { name: "aec-s-core", version: aecSVersion() });
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "aec_s_acknowledge_outbox",
      "aec_s_apply_directive",
      "aec_s_expand_task_scope",
      "aec_s_list_decisions",
      "aec_s_list_findings",
      "aec_s_poll_outbox",
      "aec_s_record_decision",
      "aec_s_resolve_decision",
      "aec_s_status",
      "aec_s_submit_task_graph",
      "aec_s_transition_finding",
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
    const unsafeExpansion = await client.callTool({
      name: "aec_s_expand_task_scope",
      arguments: {
        taskId: "mcp-task",
        addWriteGlobs: ["../outside.txt"],
        addWatchGlobs: [],
        evidence: "attempt traversal",
      },
    });
    assert.equal(unsafeExpansion.isError, true);
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
    const findings = await client.callTool({
      name: "aec_s_list_findings",
      arguments: { taskId: findingTask.id },
    });
    assert.equal(findings.isError, undefined);
    const transitioned = await client.callTool({
      name: "aec_s_transition_finding",
      arguments: { findingId: seededFinding.id, status: "verified", evidence: "MCP reviewer reproduced it" },
    });
    assert.equal(transitioned.isError, undefined);
    const polled = await client.callTool({ name: "aec_s_poll_outbox", arguments: { projectId: project.id } });
    assert.equal(polled.isError, undefined);
    const messages = (polled.structuredContent as { messages: Array<{ id: string }> }).messages;
    assert.ok(messages.length > 0);
    const acknowledged = await client.callTool({
      name: "aec_s_acknowledge_outbox",
      arguments: { messageId: messages[0]!.id },
    });
    assert.equal(acknowledged.isError, undefined);
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
  const httpToken = `test-${"mcp-http-token".repeat(3)}`;
  let resolveUrl!: (url: string) => void;
  const listening = new Promise<string>((resolve) => { resolveUrl = resolve; });
  const serving = serveMcpHttp(db, {
    port: 0,
    allowEphemeralPort: true,
    token: httpToken,
    signal: controller.signal,
    onListening: resolveUrl,
  });
  const url = await listening;
  const client = new Client({ name: "aec-s-http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${httpToken}` } },
  }));
  try {
    assert.deepEqual(client.getServerVersion(), { name: "aec-s-core", version: aecSVersion() });
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    const status = await client.callTool({ name: "aec_s_status", arguments: { projectId: "mcp-http-project" } });
    assert.equal(status.isError, undefined);
    const health = await fetch(url.replace("/mcp", "/healthz"));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "aec-s-mcp" });
    const unboundFindingTransition = await client.callTool({
      name: "aec_s_transition_finding",
      arguments: { findingId: "unbound-finding", status: "verified", evidence: "must fail closed" },
    });
    assert.equal(unboundFindingTransition.isError, true);
    const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const missingSession = await fetch(url, {
      headers: { authorization: `Bearer ${httpToken}` },
    });
    assert.equal(missingSession.status, 400);
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
