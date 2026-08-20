import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/files.js";
import { tempDir } from "./helpers.js";

test("writeJsonAtomic leaves the target unchanged when serialization fails", () => {
  const directory = tempDir("aec-s-atomic-stringify-");
  const target = join(directory, "state.json");
  writeFileSync(target, "original\n");
  const circular: { self?: unknown } = {};
  circular.self = circular;

  assert.throws(() => writeJsonAtomic(target, circular), /circular/i);
  assert.equal(readFileSync(target, "utf8"), "original\n");
  assert.deepEqual(readdirSync(directory), ["state.json"]);
});

test("writeJsonAtomic removes its temporary file when rename fails", () => {
  const directory = tempDir("aec-s-atomic-rename-");
  const target = join(directory, "state.json");
  mkdirSync(target);
  writeFileSync(join(target, "sentinel"), "original\n");

  assert.throws(() => writeJsonAtomic(target, { next: true }));
  assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "original\n");
  assert.deepEqual(readdirSync(directory), ["state.json"]);
});
