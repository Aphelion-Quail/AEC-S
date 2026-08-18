import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { launchAgentPlist, serviceAction, servicePath } from "../src/service.js";
import { builtCliPath, tempDir } from "./helpers.js";

test("LaunchAgent persists a stable executable PATH for background tools", () => {
  const home = tempDir("aec-service-");
  const runtimePath = "/opt/homebrew/bin:/usr/bin:/Applications/ChatGPT.app/Contents/Resources";
  const plist = launchAgentPlist(builtCliPath(), {
    home,
    database: join(home, "aec-s.db"),
    runs: join(home, "runs"),
    workspaces: join(home, "workspaces"),
    logs: join(home, "logs"),
    mcpHttpToken: join(home, "mcp-http.token"),
  }, runtimePath, "7447");
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<key>Label<\/key><string>dev\.aec-s\.core<\/string>/);
  assert.match(plist, new RegExp(runtimePath.replaceAll("/", "\\/")));
  assert.match(plist, /<key>AEC_S_HOME<\/key>/);
  assert.match(plist, /<key>HOME<\/key>/);
  assert.match(plist, /<key>AEC_S_MCP_HTTP_PORT<\/key><string>7447<\/string>/);
  assert.doesNotMatch(plist, /DEEPSEEK_API_KEY|TOKEN|SECRET/);
  assert.ok(servicePath().includes("/usr/bin"));
});

test("installs and removes a LaunchAgent through an injectable launchctl boundary", async () => {
  const home = tempDir("aec-service-action-");
  const plist = join(home, "dev.aec-s.core.plist");
  const paths = {
    home,
    database: join(home, "aec-s.db"),
    runs: join(home, "runs"),
    workspaces: join(home, "workspaces"),
    logs: join(home, "logs"),
    mcpHttpToken: join(home, "mcp-http.token"),
  };
  const calls: string[][] = [];
  const execute = async (command: { args: string[] }) => {
    calls.push(command.args);
    return { exitCode: 0, signal: null, stdout: "loaded", stderr: "", timedOut: false };
  };
  assert.match(await serviceAction("install", paths, { execute, plist, entry: builtCliPath() }), /Installed and started/);
  assert.equal(existsSync(plist), true);
  assert.match(readFileSync(plist, "utf8"), /<string>daemon<\/string>/);
  assert.deepEqual(calls.map((call) => call[0]), ["bootout", "bootstrap"]);
  assert.match(await serviceAction("status", paths, { execute, plist }), /loaded/);
  assert.match(await serviceAction("uninstall", paths, { execute, plist }), /Uninstalled/);
  assert.equal(existsSync(plist), false);
});
