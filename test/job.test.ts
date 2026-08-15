import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { processAlive, startSupervisedJob, waitForJob } from "../src/job.js";
import { execCommand } from "../src/exec.js";
import { tempDir } from "./helpers.js";

test("does not report a timeout until the supervised process has exited", async () => {
  const directory = tempDir("aec-timeout-");
  const marker = join(directory, "late-write.txt");
  const inputPath = join(directory, "job.input.json");
  const resultPath = join(directory, "job.result.json");
  const job = startSupervisedJob({
    command: {
      program: process.execPath,
      args: ["-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`],
      timeoutSeconds: 0.05,
    },
    stdoutPath: join(directory, "job.stdout.log"),
    stderrPath: join(directory, "job.stderr.log"),
    resultPath,
  }, inputPath);
  const result = await waitForJob(job, 1);
  assert.equal(result.status, "timed_out");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false, "a timed-out process must not keep mutating the workspace");
});

test("bounds captured command output in memory", async () => {
  const result = await execCommand({
    program: process.execPath,
    args: ["-e", "for(let i=0;i<9216;i++) process.stdout.write('x'.repeat(1024))"],
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\[output truncated\]/);
  assert.ok(result.stdout.length <= 8 * 1024 * 1024);
});

test("kills Agent descendant processes when a supervised command times out", async () => {
  const directory = tempDir("aec-process-tree-");
  const marker = join(directory, "descendant-write.txt");
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 500)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", parent], timeoutSeconds: 0.05 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }, join(directory, "input.json"));
  assert.equal((await waitForJob(job, 1)).status, "timed_out");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false);
});

test("treats an unavailable process inspector as not alive without throwing", () => {
  if (process.platform === "win32") return;
  assert.equal(processAlive(process.pid, () => ({
    status: null,
    stdout: null,
    error: new Error("spawnSync /bin/ps failed"),
  })), false);
});
