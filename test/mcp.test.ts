import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir } from "./helpers.js";

test("exposes the six AEC MCP tools over stdio", async () => {
  const home = tempDir("aec-mcp-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/cli.js"), "mcp"],
    env: { AEC_HOME: home, PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "aec-test", version: "1.0.0" });
  await client.connect(transport);
  try {
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
    const status = await client.callTool({ name: "aec_status", arguments: {} });
    assert.equal(status.isError, undefined);
  } finally {
    await client.close();
  }
});
