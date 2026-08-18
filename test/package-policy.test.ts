import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.js";

const checker = join(process.cwd(), "scripts", "check-package-policy.mjs");

function runPolicy(manifest: object, lock: object) {
  const directory = tempDir("aec-s-package-policy-");
  const manifestPath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(lockPath, JSON.stringify(lock));
  return spawnSync(process.execPath, [checker, manifestPath, lockPath], { encoding: "utf8" });
}

test("package policy rejects an unreviewed install script", () => {
  const result = runPolicy(
    { dependencies: {}, allowScripts: {} },
    { packages: { "": {}, "node_modules/native-addon": { version: "1.0.0", hasInstallScript: true } } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install scripts lack explicit approval/);
});

test("package policy rejects floating DSH preview dependencies", () => {
  const result = runPolicy(
    { dependencies: { "@deepseek-ai/dsh-example": "^0.1.0-rc.6" }, allowScripts: {} },
    { packages: { "": {}, "node_modules/@deepseek-ai/dsh-example": { version: "0.1.0-rc.6" } } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use exact RC versions/);
});
