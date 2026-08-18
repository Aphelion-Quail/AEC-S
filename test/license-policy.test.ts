import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const checkerPath = join(process.cwd(), "scripts", "check-licenses.mjs");

interface CheckerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runChecker(packages: Record<string, unknown>): CheckerResult {
  const directory = mkdtempSync(join(tmpdir(), "aec-s-license-policy-"));
  const lockPath = join(directory, "package-lock.json");
  writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages }));

  try {
    const result = spawnSync(process.execPath, [checkerPath, lockPath], { encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("license policy accepts reviewed permissive licenses", () => {
  const result = runChecker({
    "": { name: "fixture" },
    "node_modules/mit-package": { version: "1.0.0", license: "MIT" },
    "node_modules/apache-package": { version: "2.0.0", license: "Apache-2.0" },
    "node_modules/python-package": { version: "2.0.0", license: "Python-2.0" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /License policy passed for 3 packages/);
});

test("license policy rejects copyleft, unknown, and missing licenses", () => {
  const result = runChecker({
    "": { name: "fixture" },
    "node_modules/gpl-package": { version: "1.0.0", license: "GPL-3.0-only" },
    "node_modules/custom-package": { version: "1.0.0", license: "LicenseRef-Custom" },
    "node_modules/missing-package": { version: "1.0.0" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /GPL-3\.0-only/);
  assert.match(result.stderr, /LicenseRef-Custom/);
  assert.match(result.stderr, /missing license metadata/);
});
