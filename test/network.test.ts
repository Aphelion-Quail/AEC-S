import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AecSDatabase } from "../src/db.js";
import { providerHosts, startHttpsConnectProxy, startRunNetworkGateway } from "../src/network.js";
import type { Run, Workspace } from "../src/types.js";
import { createGitRepository, tempDir } from "./helpers.js";

function proxyRequest(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.setEncoding("utf8");
    socket.once("data", (data) => { resolve(String(data)); socket.destroy(); });
    socket.once("error", reject);
  });
}

test("keeps Provider allowlists adapter-owned and rejects unknown proxy destinations", async () => {
  assert.deepEqual(providerHosts({ adapter: "deepseek_harness" } as never), ["api.deepseek.com"]);
  assert.deepEqual(providerHosts({ adapter: "kimi" } as never), ["api.kimi.com", "auth.kimi.com", "cdn.kimi.com", "code.kimi.com"]);
  const proxy = await startHttpsConnectProxy(["api.openai.com"]);
  try {
    assert.match(await proxyRequest(proxy.port, "example.com:443"), /^HTTP\/1\.1 403/);
    assert.match(await proxyRequest(proxy.port, "127.0.0.1:443"), /^HTTP\/1\.1 403/);
    assert.match(await proxyRequest(proxy.port, "api.openai.com:80"), /^HTTP\/1\.1 403/);
  } finally { await proxy.close(); }
});

test("keeps the Provider proxy alive when a CONNECT client resets", async () => {
  const proxy = await startHttpsConnectProxy(["api.openai.com"]);
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
        setTimeout(() => { socket.resetAndDestroy(); resolve(); }, 50);
      });
      socket.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    await delay(100);
    assert.match(await proxyRequest(proxy.port, "example.com:443"), /^HTTP\/1\.1 403/);
  } finally { await proxy.close(); }
});

async function fixtureGateway(role: "executor" | "reviewer", expiresAt?: number, dependencyProxy?: Awaited<ReturnType<typeof startHttpsConnectProxy>>) {
  const home = tempDir("aec-s-run-network-");
  const db = new AecSDatabase(home);
  const repo = createGitRepository();
  const project = db.createProject({ name: "network", repoPath: repo, operationalConfig: { networkPolicy: { mode: "brokered", dependencyHosts: ["registry.npmjs.org"] } } });
  const task = db.createTask({ projectId: project.id, title: "Network", goal: "Use brokered network", scope: { writeGlobs: ["**"], watchGlobs: [], tags: [] }, acceptanceCriteria: ["bounded"] });
  const now = new Date().toISOString();
  const run: Run = { id: `run-${role}`, taskId: task.id, agentId: "agent", workspaceId: `workspace-${role}`, phase: role === "reviewer" ? "review" : "execute", status: "active", attempt: 1, repairCount: 0, rotationCount: 0, baseSha: "base", taskRevisionId: task.currentRevisionId, validation: [], effects: {}, logDir: home, startedAt: now, updatedAt: now };
  const workspace: Workspace = { id: run.workspaceId, projectId: project.id, taskId: task.id, runId: run.id, path: repo, branch: "main", baseSha: "base", status: "active", createdAt: now, updatedAt: now };
  const gateway = await startRunNetworkGateway({ db, run, task, project, workspace, role, expiresAt, dependencyProxy });
  return { db, gateway, repo };
}

async function connectGateway(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "aec-s-network-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test("binds Run MCP capabilities to one gateway, role, and lifetime", async () => {
  const executor = await fixtureGateway("executor");
  const reviewer = await fixtureGateway("reviewer");
  try {
    assert.equal(existsSync(executor.gateway.capabilityPath), true);
    const executorClient = await connectGateway(executor.gateway.url, executor.gateway.token);
    const reviewerClient = await connectGateway(reviewer.gateway.url, reviewer.gateway.token);
    try {
      assert.deepEqual((await executorClient.listTools()).tools.map(({ name }) => name).sort(), ["aec_s_fetch", "aec_s_network_exec"]);
      assert.deepEqual((await reviewerClient.listTools()).tools.map(({ name }) => name), ["aec_s_fetch"]);
      const rejected = await executorClient.callTool({ name: "aec_s_fetch", arguments: { url: "https://127.0.0.1/latest/meta-data" } });
      assert.equal(rejected.isError, true);
      await assert.rejects(connectGateway(reviewer.gateway.url, executor.gateway.token));
      const events = executor.db.listEvents(undefined, 10);
      assert.equal(events.some((event) => JSON.stringify(event).includes("latest/meta-data")), false);
    } finally { await executorClient.close(); await reviewerClient.close(); }
  } finally {
    await executor.gateway.close(); await reviewer.gateway.close();
    assert.equal(existsSync(executor.gateway.capabilityPath), false);
    executor.db.close(); reviewer.db.close();
  }
});

test("rejects an expired Run capability", async () => {
  const { db, gateway } = await fixtureGateway("reviewer", Date.now() - 1);
  try { await assert.rejects(connectGateway(gateway.url, gateway.token)); }
  finally { await gateway.close(); db.close(); }
});

test("runs dependency commands without ambient Runtime, GitHub, or SSH credentials", async () => {
  const proxy = await startHttpsConnectProxy(["registry.npmjs.org"]);
  const fixture = await fixtureGateway("executor", undefined, proxy);
  const bin = `${fixture.repo}/test-bin`;
  mkdirSync(bin);
  const fakeNpm = `${bin}/npm`;
  writeFileSync(fakeNpm, `#!${process.execPath}\nconst keys=['OPENAI_API_KEY','MOONSHOT_API_KEY','DEEPSEEK_API_KEY','GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','AEC_S_RUN_MCP_TOKEN'];process.stdout.write(JSON.stringify(keys.filter(key=>process.env[key])));\n`);
  chmodSync(fakeNpm, 0o700);
  const previousPath = process.env.PATH;
  const credentialKeys = ["OPENAI_API_KEY", "MOONSHOT_API_KEY", "DEEPSEEK_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AEC_S_RUN_MCP_TOKEN"] as const;
  const previousCredentials = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
  for (const key of credentialKeys) process.env[key] = `synthetic-${key.toLowerCase()}`;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const client = await connectGateway(fixture.gateway.url, fixture.gateway.token);
  try {
    const called = await client.callTool({ name: "aec_s_network_exec", arguments: { program: "npm", args: ["view", "zod", "version"] } });
    assert.equal(called.isError, undefined);
    const text = (called.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
    const result = JSON.parse(text) as { stdout: string };
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal((await client.callTool({ name: "aec_s_network_exec", arguments: { program: "npm", args: ["publish"] } })).isError, true);
    assert.equal((await client.callTool({ name: "aec_s_network_exec", arguments: { program: "npx", args: ["example"] } })).isError, true);
  } finally {
    process.env.PATH = previousPath;
    for (const key of credentialKeys) {
      const previous = previousCredentials[key];
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
    await client.close();
    await fixture.gateway.close();
    fixture.db.close();
    await proxy.close();
  }
});
