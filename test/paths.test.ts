import test from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAecSPaths, getAecSPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

test("refuses broad, populated, and symbolic-link AEC_S_HOME targets", () => {
  assert.throws(() => ensureAecSPaths(getAecSPaths(process.env.HOME)), /protected broad directory/);

  const populated = tempDir("aec-s-unsafe-home-");
  writeFileSync(join(populated, "personal.txt"), "do not chmod this directory");
  assert.throws(() => ensureAecSPaths(getAecSPaths(populated)), /not owned by AEC-S/);

  const parent = tempDir("aec-s-symlink-home-");
  const target = tempDir("aec-s-symlink-target-");
  const link = join(parent, "state");
  symlinkSync(target, link, "dir");
  assert.throws(() => ensureAecSPaths(getAecSPaths(link)), /symbolic link/);
});
