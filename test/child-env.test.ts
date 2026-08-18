import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnvironment } from "../src/child-env.js";
import { execCommand } from "../src/exec.js";
import { startSupervisedJob, waitForJob } from "../src/job.js";
import { tempDir } from "./helpers.js";

test("builds capability-scoped child environments", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/tmp/user",
    DEEPSEEK_API_KEY: "runtime-credential",
    OPENAI_API_KEY: "codex-credential",
    GH_TOKEN: "controller-credential",
    UNRELATED_SECRET: "must-not-pass",
  };
  assert.deepEqual(childEnvironment("restricted", {}, source), { PATH: "/usr/bin", HOME: "/tmp/user" });
  assert.deepEqual(childEnvironment("deepseek_harness", {}, source), {
    PATH: "/usr/bin",
    HOME: "/tmp/user",
    DEEPSEEK_API_KEY: "runtime-credential",
  });
  assert.deepEqual(childEnvironment("codex", {}, source), {
    PATH: "/usr/bin",
    HOME: "/tmp/user",
    OPENAI_API_KEY: "codex-credential",
  });
});

test("ordinary commands do not inherit daemon secrets", async () => {
  const key = "AEC_S_TEST_UNRELATED_SECRET";
  const previous = process.env[key];
  process.env[key] = `hidden-${Date.now()}`;
  try {
    const result = await execCommand({
      program: process.execPath,
      args: ["-e", `process.stdout.write(process.env.${key} ?? "absent")`],
    });
    assert.equal(result.stdout, "absent");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("runtime jobs receive only approved credentials without persisting their values", async () => {
  const directory = tempDir("aec-s-runtime-env-");
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "stdout.log");
  const value = `runtime-${Date.now()}`;
  const previousRuntime = process.env.DEEPSEEK_API_KEY;
  const previousUnrelated = process.env.UNRELATED_RUNTIME_SECRET;
  process.env.DEEPSEEK_API_KEY = value;
  process.env.UNRELATED_RUNTIME_SECRET = "not-visible";
  try {
    const job = startSupervisedJob({
      command: {
        program: process.execPath,
        args: ["-e", "process.stdout.write(`${process.env.DEEPSEEK_API_KEY ?? 'missing'}:${process.env.UNRELATED_RUNTIME_SECRET ?? 'absent'}`)"],
      },
      environmentProfile: "deepseek_harness",
      stdoutPath: outputPath,
      stderrPath: join(directory, "stderr.log"),
      resultPath: join(directory, "result.json"),
    }, inputPath);
    assert.equal((await waitForJob(job, 5)).exitCode, 0);
    assert.equal(readFileSync(outputPath, "utf8"), `${value}:absent`);
    assert.equal(readFileSync(inputPath, "utf8").includes(value), false);
  } finally {
    if (previousRuntime === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousRuntime;
    if (previousUnrelated === undefined) delete process.env.UNRELATED_RUNTIME_SECRET;
    else process.env.UNRELATED_RUNTIME_SECRET = previousUnrelated;
  }
});

test("captured output limits are enforced in UTF-8 bytes", async () => {
  const result = await execCommand({
    program: process.execPath,
    args: ["-e", "process.stdout.write('😀'.repeat(3 * 1024 * 1024))"],
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 8 * 1024 * 1024);
  assert.match(result.stdout, /\[output truncated\]/);
});
