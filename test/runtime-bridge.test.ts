import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tempDir } from "./helpers.js";

const bridge = fileURLToPath(new URL("../src/runtime-bridge.js", import.meta.url));

test("runtime bridge emits a bounded structured diagnostic for unsupported runtimes", () => {
  const directory = tempDir("aec-s-runtime-bridge-");
  const result = spawnSync(process.execPath, [bridge, "unsupported", "execute", directory, join(directory, "result.json")], {
    input: "{}",
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  const diagnostic = JSON.parse(result.stderr.trim()) as { code?: string; message?: string };
  assert.equal(diagnostic.code, "runtime_bridge_error");
  assert.match(diagnostic.message ?? "", /Unsupported runtime bridge/);
  assert.ok(Buffer.byteLength(result.stderr) < 4_000);
});

