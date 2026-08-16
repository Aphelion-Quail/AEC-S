import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { launchAgentPlist, servicePath } from "../src/service.js";
import { builtCliPath, tempDir } from "./helpers.js";

test("LaunchAgent persists a stable executable PATH for background tools", () => {
  const home = tempDir("aec-service-");
  const runtimePath = "/opt/homebrew/bin:/usr/bin:/Applications/ChatGPT.app/Contents/Resources";
  const plist = launchAgentPlist(builtCliPath(), {
    home,
    database: join(home, "aec.db"),
    runs: join(home, "runs"),
    workspaces: join(home, "workspaces"),
    logs: join(home, "logs"),
  }, runtimePath);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, new RegExp(runtimePath.replaceAll("/", "\\/")));
  assert.match(plist, /<key>AEC_HOME<\/key>/);
  assert.ok(servicePath().includes("/usr/bin"));
});
