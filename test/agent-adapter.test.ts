import test from "node:test";
import assert from "node:assert/strict";
import { adapterFor } from "../src/adapters/agent.js";
import type { Agent } from "../src/types.js";
import { tempDir } from "./helpers.js";
import { executableCandidates } from "../src/runtime-discovery.js";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeDeepSeekHarness, probeKimi } from "../src/runtime-probe.js";
import { runKimiAcp } from "../src/kimi-acp.js";

const agent: Agent = {
  id: "codex",
  name: "Codex",
  adapter: "codex",
  roles: ["executor", "reviewer"],
  capabilities: [],
  enabled: true,
  availability: "available",
  maxConcurrency: 1,
  currentLoad: 0,
  config: { binary: "codex", ignoreUserConfig: true },
};

test("applies the same explicit Codex workspace boundary to fresh and resumed writes", () => {
  const workspace = tempDir("aec-s-codex-workspace-");
  const runDir = tempDir("aec-s-codex-run-");
  const adapter = adapterFor(agent);
  const base = {
    kind: "execute",
    prompt: "execute",
    workspacePath: workspace,
    runDir,
    schemaPath: `${runDir}/worker.json`,
  } as const;
  const started = adapter.start(base);
  const fresh = adapter.execute(base);
  const repairInput = {
    kind: "repair",
    prompt: "repair",
    workspacePath: workspace,
    runDir,
    schemaPath: `${runDir}/worker.json`,
    sessionId: "00000000-0000-0000-0000-000000000001",
  } as const;
  const repaired = adapter.repair(repairInput);
  const resumed = adapter.resume(repairInput);
  for (const [index, invocation] of [started, fresh, repaired, resumed].entries()) {
    assert.equal(invocation.command.cwd, workspace);
    assert.deepEqual(invocation.command.args.slice(0, 8), [
      "--ask-for-approval", "never", "--sandbox", "workspace-write", "--cd", workspace, "exec", index >= 2 ? "resume" : "--json",
    ]);
  }
});

test("forces independent Codex review into a read-only workspace", () => {
  const workspace = tempDir("aec-s-codex-review-");
  const runDir = tempDir("aec-s-codex-review-run-");
  const invocation = adapterFor(agent).invocation({
    kind: "review",
    prompt: "review",
    workspacePath: workspace,
    runDir,
    schemaPath: `${runDir}/review.json`,
  });
  assert.deepEqual(invocation.command.args.slice(0, 7), [
    "--ask-for-approval", "never", "--sandbox", "read-only", "--cd", workspace, "exec",
  ]);
});

for (const runtime of ["kimi", "deepseek_harness"] as const) {
  test(`${runtime} uses the same lifecycle bridge for execute, review, repair, and resume`, () => {
    const workspace = tempDir(`aec-s-${runtime}-workspace-`);
    const runDir = tempDir(`aec-s-${runtime}-run-`);
    const runtimeAgent: Agent = {
      ...agent,
      id: runtime,
      name: runtime,
      adapter: runtime,
      runtimeFamily: runtime,
      runtimeCapabilities: { resume: true, cancel: true, stream: true, reviewMode: true, structuredOutput: true },
      config: runtime === "kimi"
        ? { binary: process.execPath }
        : { command: process.execPath, args: ["fake-dsh-runtime.js"] },
    };
    const adapter = adapterFor(runtimeAgent);
    const schemaPath = join(runDir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", enum: ["complete"] } },
    }));
    const base = { prompt: "structured", workspacePath: workspace, runDir, schemaPath };
    const invocations = [
      adapter.start({ ...base, kind: "execute" }),
      adapter.execute({ ...base, kind: "execute" }),
      adapter.review({ ...base, kind: "review" }),
      adapter.repair({ ...base, kind: "repair", sessionId: "session-one" }),
      adapter.resume({ ...base, kind: "repair", sessionId: "session-one" }),
    ];
    assert.deepEqual(invocations.map((invocation) => invocation.command.args[2]), ["execute", "execute", "review", "repair", "repair"]);
    assert.ok(invocations.every((invocation) => invocation.command.program === process.execPath));
    assert.ok(invocations.every((invocation) => invocation.command.args[1] === runtime));
    assert.equal(invocations[3]!.command.args[5], "session-one");
    assert.equal(invocations[4]!.command.args[5], "session-one");
    assert.ok(invocations.every((invocation) => invocation.stdin?.includes("AEC-S CONTROL OUTPUT CONTRACT")));
    assert.ok(invocations.every((invocation) => invocation.stdin?.includes('"additionalProperties":false')));
    assert.ok(invocations.every((invocation) => invocation.stdin?.includes("Do not rename fields")));
    assert.equal(adapter.status(999_999_999), "stopped");
    const resultPath = join(runDir, "result.json");
    writeFileSync(resultPath, JSON.stringify({ status: "complete" }));
    assert.deepEqual(adapter.collectResult(resultPath), { status: "complete" });
    adapter.close();
  });
}

test("Codex, Kimi, and DeepSeek Harness expose isolated cancel lifecycle control", async () => {
  for (const runtime of ["codex", "kimi", "deepseek_harness"] as const) {
    const runtimeAgent: Agent = {
      ...agent,
      id: runtime,
      name: runtime,
      adapter: runtime,
      runtimeFamily: runtime,
      config: runtime === "deepseek_harness" ? { command: process.execPath } : { binary: process.execPath },
    };
    const adapter = adapterFor(runtimeAgent);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    assert.ok(child.pid);
    assert.equal(adapter.status(child.pid!), "running");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    adapter.cancel(child.pid!);
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${runtime} cancel timed out`)), 2_000)),
    ]);
    assert.equal(adapter.status(child.pid!), "stopped");
    adapter.close();
  }
});

test("Kimi discovery includes the official installation directory", () => {
  assert.ok(executableCandidates("kimi").includes(join(homedir(), ".kimi-code", "bin", "kimi")));
});

test("Codex discovery includes the official macOS application directories", () => {
  const candidates = executableCandidates("codex");
  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"));
  assert.ok(candidates.includes("/Applications/Codex.app/Contents/Resources/codex"));
  assert.ok(candidates.includes(join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex")));
});

function fakeKimi(mode: "acp" | "cancel" | "outside" | "symlink" | "missing-location" | "legacy" | "incompatible"): string {
  const root = tempDir("aec-s-fake-kimi-");
  const binary = join(root, "kimi");
  writeFileSync(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9-test'); process.exit(0); }
if (args[0] === 'provider' && args[1] === 'list') {
  console.log('managed:kimi-code  type=kimi  models=1  source=oauth'); process.exit(0);
}
const mode = ${JSON.stringify(mode)};
if (args[0] === 'acp' && mode !== 'acp' && mode !== 'cancel' && mode !== 'outside' && mode !== 'symlink' && mode !== 'missing-location') {
  console.error("error: unknown command 'acp'"); process.exit(1);
}
if (args[0] !== 'acp' && mode === 'incompatible') {
  console.error("error: unknown option '--work-dir'"); process.exit(1);
}
process.stdin.setEncoding('utf8');
let buffer = '';
let pendingPrompt;
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (mode === 'cancel') require('node:fs').appendFileSync(${JSON.stringify(`${binary}.received`)}, String(request.method || 'response') + '\\n');
    if (request.id === 'permission-1' && !request.method && pendingPrompt !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'fake-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: {
          type: 'text', text: '{"status":"complete"}'
        } }
      } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: pendingPrompt, result: {
        stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      } }) + '\\n');
      pendingPrompt = undefined;
      continue;
    }
    if (request.method === 'initialize') {
      const result = mode === 'acp' || mode === 'cancel' || mode === 'outside' || mode === 'symlink' || mode === 'missing-location' ? {
        protocolVersion: 1,
        agentInfo: { name: 'Kimi Code CLI', version: '9.9.9-test' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {}, delete: {} },
          promptCapabilities: { image: true, audio: false, embeddedContext: true }
        }
      } : {
        protocol_version: '1.7', server: { name: 'Kimi Code CLI', version: '9.9.9-test' }, slash_commands: []
      };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    } else if (request.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        sessionId: 'fake-acp-session',
        modes: { currentModeId: 'default', availableModes: [
          { id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }, { id: 'auto', name: 'Auto' }
        ] },
        configOptions: []
      } }) + '\\n');
    } else if (request.method === 'session/resume' || request.method === 'session/load') {
      if (request.method === 'session/load') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'fake-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: {
          type: 'text', text: '{"status":"old-history"}'
        } }
      } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        modes: { currentModeId: 'plan', availableModes: [
          { id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }, { id: 'auto', name: 'Auto' }
        ] },
        configOptions: []
      } }) + '\\n');
    } else if (request.method === 'session/delete') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
    } else if (request.method === 'session/set_mode' || request.method === 'session/close') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
    } else if (request.method === 'session/prompt') {
      pendingPrompt = request.id;
      if (mode !== 'cancel') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
        sessionId: 'fake-acp-session',
        toolCall: { toolCallId: 'tool-1', title: 'edit', kind: 'edit', status: 'pending', ...(mode === 'missing-location' ? {} : { locations: [{
          path: mode === 'outside' ? '/tmp/aec-s-outside-scope.ts' : mode === 'symlink' ? process.cwd() + '/escape/outside.ts' : process.cwd() + '/file.ts'
        }] }) },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject once', kind: 'reject_once' }
        ]
      } }) + '\\n');
    } else if (request.method === 'session/cancel' && mode === 'cancel') {
      require('node:fs').writeFileSync(${JSON.stringify(`${binary}.cancelled`)}, 'cancelled');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } }) + '\\n');
      pendingPrompt = undefined;
    }
  }
});
setInterval(() => {}, 1000);
`);
  chmodSync(binary, 0o700);
  return binary;
}

test("Kimi probe requires ACP by default and permits the legacy wire only when explicitly configured", async () => {
  const compatible = await probeKimi(fakeKimi("acp"), process.cwd());
  assert.equal(compatible.ok, true);
  assert.equal(compatible.checks?.authentication.ok, true);
  assert.equal(compatible.checks?.compatibility.ok, true);
  assert.equal(compatible.transport, "acp");

  const legacy = await probeKimi(fakeKimi("legacy"), process.cwd());
  assert.equal(legacy.ok, false);
  assert.match(legacy.detail, /explicit transport=agent_sdk_wire/);
  const explicitLegacy = await probeKimi(fakeKimi("legacy"), process.cwd(), "agent_sdk_wire");
  assert.equal(explicitLegacy.ok, true);
  assert.equal(explicitLegacy.transport, "agent_sdk_wire");

  const incompatible = await probeKimi(fakeKimi("incompatible"), process.cwd());
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.checks?.authentication.ok, true);
  assert.equal(incompatible.checks?.compatibility.ok, false);
  assert.match(incompatible.detail, /unknown option '--work-dir'/);
  assert.doesNotMatch(incompatible.detail, /log in|login/i);
});

test("Kimi ACP controls execution, read-only review, resume, permissions, streaming, and usage", async () => {
  const workspace = tempDir("aec-s-kimi-acp-workspace-");
  const binary = fakeKimi("acp");
  const executed = await runKimiAcp({ binary, workspace, prompt: "execute", kind: "execute" });
  assert.equal(executed.text, '{"status":"complete"}');
  assert.equal(executed.sessionId, "fake-acp-session");
  assert.equal(executed.permissionSummary.allowedOnce, 1);
  assert.equal(executed.permissionSummary.rejected, 0);
  assert.deepEqual(executed.usage, { input: 3, output: 2, total: 5 });

  const reviewed = await runKimiAcp({
    binary,
    workspace,
    prompt: "review",
    kind: "review",
    sessionId: executed.sessionId,
  });
  assert.equal(reviewed.sessionId, executed.sessionId);
  assert.equal(reviewed.text, '{"status":"complete"}');
  assert.equal(reviewed.permissionSummary.allowedOnce, 0);
  assert.equal(reviewed.permissionSummary.rejected, 1);

  const outside = await runKimiAcp({ binary: fakeKimi("outside"), workspace, prompt: "execute", kind: "execute" });
  assert.equal(outside.permissionSummary.allowedOnce, 0);
  assert.equal(outside.permissionSummary.rejected, 1);

  const outsideTarget = tempDir("aec-s-kimi-symlink-target-");
  symlinkSync(outsideTarget, join(workspace, "escape"));
  const symlinkEscape = await runKimiAcp({ binary: fakeKimi("symlink"), workspace, prompt: "execute", kind: "execute" });
  assert.equal(symlinkEscape.permissionSummary.allowedOnce, 0);
  assert.equal(symlinkEscape.permissionSummary.rejected, 1);

  const missingLocation = await runKimiAcp({ binary: fakeKimi("missing-location"), workspace, prompt: "execute", kind: "execute" });
  assert.equal(missingLocation.permissionSummary.allowedOnce, 0);
  assert.equal(missingLocation.permissionSummary.rejected, 1);
});

test("Kimi ACP translates process cancellation into session/cancel before process termination", async () => {
  const workspace = tempDir("aec-s-kimi-acp-cancel-");
  const binary = fakeKimi("cancel");
  const controller = new AbortController();
  const running = runKimiAcp({ binary, workspace, prompt: "wait", kind: "execute", signal: controller.signal });
  const receivedPath = `${binary}.received`;
  const deadline = Date.now() + 2_000;
  while ((!existsSync(receivedPath) || !readFileSync(receivedPath, "utf8").includes("session/prompt")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  controller.abort();
  await assert.rejects(running, /cancelled/);
  const received = existsSync(`${binary}.received`) ? readFileSync(`${binary}.received`, "utf8") : "no ACP messages";
  assert.equal(existsSync(`${binary}.cancelled`), true, `Kimi fake received:\n${received}`);
  assert.equal(readFileSync(`${binary}.cancelled`, "utf8"), "cancelled");
});

test("runtime bridge executes the Kimi ACP lifecycle and persists only structured output", () => {
  const workspace = tempDir("aec-s-runtime-bridge-workspace-");
  const output = join(tempDir("aec-s-runtime-bridge-output-"), "result.json");
  const bridge = fileURLToPath(new URL("../src/runtime-bridge.js", import.meta.url));
  const config = Buffer.from(JSON.stringify({ binary: fakeKimi("acp"), transport: "acp" })).toString("base64url");
  const result = spawnSync(process.execPath, [bridge, "kimi", "execute", workspace, output, "", config], {
    input: "Return one JSON object",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { status: "complete" });
  const metadata = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.equal(metadata.runtime, "kimi");
  assert.equal(metadata.runtime_transport, "acp");
  assert.equal(metadata.runtime_session_id, "fake-acp-session");
});

test("DSH probe uses its credential seam and initializes both pinned compositions", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only-not-a-real-secret";
  const root = fileURLToPath(new URL("../..", import.meta.url));
  try {
    const result = await probeDeepSeekHarness({
      command: join(root, "node_modules", ".bin", "dsh-jsonrpc-agent"),
      configs: [
        join(root, "runtime", "dsh", "executor.cordis.yml"),
        join(root, "runtime", "dsh", "reviewer.cordis.yml"),
      ],
      workspace: root,
      dshHome: tempDir("aec-s-dsh-home-"),
      requestedPackageVersion: "0.1.0-rc.6",
    });
    assert.equal(result.ok, true);
    assert.equal(result.checks?.authentication.ok, true);
    assert.equal(result.checks?.compatibility.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /test-only-not-a-real-secret/);
    for (const name of ["executor", "reviewer"]) {
      assert.match(readFileSync(join(root, "runtime", "dsh", `${name}.cordis.yml`), "utf8"), /dsh-credentials-local/);
    }
    const executorComposition = readFileSync(join(root, "runtime", "dsh", "executor.cordis.yml"), "utf8");
    assert.match(executorComposition, /mode:\s*workspace-write/);
    assert.doesNotMatch(executorComposition, /mode:\s*danger-full-access/);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});
