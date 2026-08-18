import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive, startSupervisedJob, waitForJob } from "../src/job.js";
import { execCommand } from "../src/exec.js";
import { tempDir } from "./helpers.js";

test("does not report a timeout until the supervised process has exited", async () => {
  const directory = tempDir("aec-s-timeout-");
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

test("terminates supervised commands that exceed the durable log limit", async () => {
  const directory = tempDir("aec-s-job-output-limit-");
  const stdoutPath = join(directory, "stdout.log");
  const job = startSupervisedJob({
    command: {
      program: process.execPath,
      args: ["-e", "for(let i=0;i<9216;i++) process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000)"],
      timeoutSeconds: 10,
    },
    stdoutPath,
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }, join(directory, "input.json"));
  const result = await waitForJob(job, 5);
  assert.equal(result.status, "output_limit");
  assert.ok(statSync(stdoutPath).size <= 8 * 1024 * 1024);
});

test("deduplicates supervisors across the persisted pre-spawn crash window", async () => {
  const directory = tempDir("aec-s-supervisor-dedup-");
  const marker = join(directory, "side-effect.txt");
  const input = {
    command: {
      program: process.execPath,
      args: ["-e", `setTimeout(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'once'),250)`],
      timeoutSeconds: 5,
    },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  };
  const inputPath = join(directory, "input.json");
  const first = startSupervisedJob(input, inputPath, "same-job");
  const reconciler = startSupervisedJob(input, inputPath, "same-job");
  await Promise.all([waitForJob(first, 5), waitForJob(reconciler, 5)]);
  assert.equal(readFileSync(marker, "utf8"), "once");
});

test("kills Agent descendant processes when a supervised command times out", async () => {
  const directory = tempDir("aec-s-process-tree-");
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

test("kills descendant processes when a direct command times out", async () => {
  const directory = tempDir("aec-s-direct-process-tree-");
  const marker = join(directory, "descendant-write.txt");
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 500)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const result = await execCommand({ program: process.execPath, args: ["-e", parent], timeoutSeconds: 0.05 });
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false);
});

test("forwards manual cancellation to the Runtime before the process-group backstop", async () => {
  if (process.platform === "win32") return;
  const directory = tempDir("aec-s-manual-cancel-");
  const ready = join(directory, "runtime-ready.txt");
  const marker = join(directory, "runtime-sigterm.txt");
  const program = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.once('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'received');process.exit(0)});setInterval(()=>{},1000)`;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], timeoutSeconds: 10 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }, join(directory, "input.json"));
  const deadline = Date.now() + 2_000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(existsSync(ready), true);
  assert.ok(job.pid);
  process.kill(-job.pid!, "SIGTERM");
  await waitForJob(job, 3);
  assert.equal(readFileSync(marker, "utf8"), "received");
});

test("falls back to PID existence when the process inspector is unavailable", () => {
  if (process.platform === "win32") return;
  assert.equal(processAlive(process.pid, () => ({
    status: null,
    stdout: null,
    error: new Error("spawnSync /bin/ps failed"),
  })), true);
  assert.equal(processAlive(process.pid, () => ({ status: 0, stdout: "Z\n" })), false);
});
