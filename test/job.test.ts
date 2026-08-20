import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive, runJobFile, startSupervisedJob, waitForJob } from "../src/job.js";
import { execCommand, execCommandToFile } from "../src/exec.js";
import { tempDir } from "./helpers.js";
import type { JobInput } from "../src/types.js";
import { writeJsonAtomic } from "../src/files.js";

function isolated(directory: string, input: Omit<JobInput, "isolation">): JobInput {
  const runtimeOutputPath = join(directory, "runtime-output");
  const workspacePath = join(directory, "workspace");
  mkdirSync(runtimeOutputPath, { recursive: true, mode: 0o700 });
  mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
  return {
    ...input,
    isolation: {
      workspacePath,
      mode: "workspace-write",
      networkAccess: "none",
      controllerPath: directory,
      runtimeOutputPath,
      homePath: join(directory, "isolated-home"),
      tempPath: join(directory, "isolated-tmp"),
    },
  };
}

test("does not report a timeout until the supervised process has exited", async () => {
  const directory = tempDir("aec-s-timeout-");
  const marker = join(directory, "late-write.txt");
  const inputPath = join(directory, "job.input.json");
  const resultPath = join(directory, "job.result.json");
  const job = startSupervisedJob(isolated(directory, {
    command: {
      program: process.execPath,
      args: ["-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`],
      timeoutSeconds: 0.05,
    },
    stdoutPath: join(directory, "job.stdout.log"),
    stderrPath: join(directory, "job.stderr.log"),
    resultPath,
  }), inputPath);
  const result = await waitForJob(job, 1);
  assert.equal(result.status, "timed_out");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false, "a timed-out process must not keep mutating the workspace");
});

test("records a fast command result when the empty stdin pipe closes with EPIPE", async () => {
  const directory = tempDir("aec-s-fast-job-");
  const job = startSupervisedJob(isolated(directory, {
    command: { program: "/usr/bin/true", args: [] },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }), join(directory, "input.json"));
  const result = await waitForJob(job, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
});

test("bounds captured command output in memory", async () => {
  const result = await execCommand({
    program: process.execPath,
    args: ["-e", "for(let i=0;i<9216;i++) process.stdout.write('x'.repeat(1024))"],
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.endsWith("\n[output truncated]\n"));
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 8 * 1024 * 1024);
});

test("bounds invalid UTF-8 command output after decoding", async () => {
  const result = await execCommand({
    program: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0xff))"],
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.endsWith("\n[output truncated]\n"));
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 8 * 1024 * 1024);
});

test("bounds stderr while streaming command output to a file", async () => {
  const directory = tempDir("aec-s-command-file-output-");
  const outputPath = join(directory, "stdout.log");
  const result = await execCommandToFile({
    program: process.execPath,
    args: ["-e", "process.stdout.write('file output'); for(let i=0;i<9216;i++) process.stderr.write('x'.repeat(1024))"],
    timeoutSeconds: 10,
  }, outputPath);
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(outputPath, "utf8"), "file output");
  assert.ok(result.stderr.endsWith("\n[output truncated]\n"));
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 8 * 1024 * 1024);
});

test("terminates supervised commands that exceed the durable log limit", async () => {
  const directory = tempDir("aec-s-job-output-limit-");
  const stdoutPath = join(directory, "stdout.log");
  const job = startSupervisedJob(isolated(directory, {
    command: {
      program: process.execPath,
      args: ["-e", "for(let i=0;i<9216;i++) process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000)"],
      timeoutSeconds: 10,
    },
    stdoutPath,
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }), join(directory, "input.json"));
  const result = await waitForJob(job, 5);
  assert.equal(result.status, "output_limit");
  assert.ok(statSync(stdoutPath).size <= 8 * 1024 * 1024);
});

test("deduplicates supervisors across the persisted pre-spawn crash window", async () => {
  const directory = tempDir("aec-s-supervisor-dedup-");
  const marker = join(directory, "workspace", "side-effect.txt");
  const input = isolated(directory, {
    command: {
      program: process.execPath,
      args: ["-e", `setTimeout(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'once'),250)`],
      timeoutSeconds: 5,
    },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  });
  const inputPath = join(directory, "input.json");
  const first = startSupervisedJob(input, inputPath, "same-job");
  const reconciler = startSupervisedJob(input, inputPath, "same-job");
  await Promise.all([waitForJob(first, 5), waitForJob(reconciler, 5)]);
  assert.equal(readFileSync(marker, "utf8"), "once");
});

test("kills the prior command before recovering a supervisor crash after spawn", async () => {
  const directory = tempDir("aec-s-supervisor-post-spawn-");
  const spawned = join(directory, "workspace", "spawned.txt");
  const sideEffect = join(directory, "workspace", "side-effect.txt");
  const input = isolated(directory, {
    command: {
      program: process.execPath,
      args: ["-e", `
        const fs=require('node:fs');
        fs.writeFileSync(${JSON.stringify(spawned)},String(process.pid));
        setTimeout(()=>fs.appendFileSync(${JSON.stringify(sideEffect)},process.pid+':'+Date.now()+'\\n'),500);
        setTimeout(()=>process.exit(0),900);
      `],
      timeoutSeconds: 5,
    },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  });
  const inputPath = join(directory, "input.json");
  const first = startSupervisedJob(input, inputPath, "recover-after-spawn");
  const spawnDeadline = Date.now() + 3_000;
  while (!existsSync(spawned) && Date.now() < spawnDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(existsSync(spawned), true);
  assert.ok(first.pid);
  process.kill(first.pid!, "SIGKILL");
  const reconciler = startSupervisedJob(input, inputPath, "recover-after-spawn");
  assert.equal((await waitForJob(reconciler, 5)).status, "completed");
  const sideEffects = readFileSync(sideEffect, "utf8").trim().split(/\r?\n/);
  assert.equal(sideEffects.length, 1, sideEffects.join(", "));
});

test("kills Agent descendant processes when a supervised command times out", async () => {
  const directory = tempDir("aec-s-process-tree-");
  const marker = join(directory, "descendant-write.txt");
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 500)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const job = startSupervisedJob(isolated(directory, {
    command: { program: process.execPath, args: ["-e", parent], timeoutSeconds: 0.05 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }), join(directory, "input.json"));
  assert.equal((await waitForJob(job, 1)).status, "timed_out");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false);
});

test("kills a detached Runtime descendant recorded before the entrypoint exits", async () => {
  if (process.platform === "win32") return;
  const directory = tempDir("aec-s-detached-descendant-");
  const marker = join(directory, "workspace", "detached-write.txt");
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 900);setTimeout(()=>process.exit(0),1200)`;
  const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});child.unref();setTimeout(()=>process.exit(0),300)`;
  const job = startSupervisedJob(isolated(directory, {
    command: { program: process.execPath, args: ["-e", parent], timeoutSeconds: 5 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }), join(directory, "input.json"));
  assert.equal((await waitForJob(job, 5)).exitCode, 0);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(existsSync(marker), false);
});

test("kills a detached Runtime descendant when the entrypoint exits immediately", async () => {
  if (process.platform !== "darwin") return;
  for (let trial = 0; trial < 5; trial += 1) {
    const directory = tempDir(`aec-s-rapid-detached-${trial}-`);
    const marker = join(directory, "workspace", "detached-write.txt");
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 700);setTimeout(()=>process.exit(0),900)`;
    const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});child.unref();process.exit(0)`;
    const job = startSupervisedJob(isolated(directory, {
      command: { program: process.execPath, args: ["-e", parent], timeoutSeconds: 5 },
      stdoutPath: join(directory, "stdout.log"),
      stderrPath: join(directory, "stderr.log"),
      resultPath: join(directory, "result.json"),
    }), join(directory, "input.json"));
    assert.equal((await waitForJob(job, 5)).status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(existsSync(marker), false, `trial ${trial} leaked a detached descendant`);
  }
});

test("tracks a detached subtree after its original parent exits", async () => {
  if (process.platform !== "darwin") return;
  const directory = tempDir("aec-s-reparented-subtree-");
  const marker = join(directory, "workspace", "late-descendant-write.txt");
  const leaf = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'leaked'),1200);setTimeout(()=>process.exit(0),1400)`;
  const helper = `const {spawn}=require('node:child_process');setTimeout(()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'});child.unref()},500);setTimeout(()=>process.exit(0),750)`;
  const intermediary = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{detached:true,stdio:'ignore'});child.unref();setTimeout(()=>process.exit(0),200)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediary)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),1000)`;
  const job = startSupervisedJob(isolated(directory, {
    command: { program: process.execPath, args: ["-e", parent], timeoutSeconds: 5 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }), join(directory, "input.json"));
  assert.equal((await waitForJob(job, 5)).status, "completed");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(existsSync(marker), false);
});

test("prunes exited descendant identities while the command remains active", async () => {
  if (process.platform !== "darwin") return;
  const directory = tempDir("aec-s-descendant-pruning-");
  const pidPath = join(directory, "workspace", "short-child.pid");
  const resultPath = join(directory, "result.json");
  const shortChild = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>process.exit(0),600)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(shortChild)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),2500)`;
  const job = startSupervisedJob(isolated(directory, {
    command: { program: process.execPath, args: ["-e", parent], timeoutSeconds: 5 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath,
  }), join(directory, "input.json"));
  const pidDeadline = Date.now() + 2_000;
  while (!existsSync(pidPath) && Date.now() < pidDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(existsSync(pidPath), true);
  const shortPid = Number(readFileSync(pidPath, "utf8"));
  const lockPath = `${resultPath}.supervisor.lock`;
  const includesShortPid = (): boolean => {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { descendants?: Array<{ pid: number }> };
      return lock.descendants?.some(({ pid }) => pid === shortPid) ?? false;
    } catch { return false; }
  };
  const observedDeadline = Date.now() + 1_000;
  while (!includesShortPid() && Date.now() < observedDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(includesShortPid(), true, "short-lived descendant was never persisted");
  const pruneDeadline = Date.now() + 1_500;
  while (includesShortPid() && Date.now() < pruneDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(includesShortPid(), false, "dead descendant identity remained in the hot census set");
  assert.equal(existsSync(resultPath), false, "command exited before descendant pruning was observed");
  assert.equal((await waitForJob(job, 5)).status, "completed");
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
  const ready = join(directory, "workspace", "runtime-ready.txt");
  const marker = join(directory, "workspace", "runtime-sigterm.txt");
  const program = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.once('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'received');process.exit(0)});setInterval(()=>{},1000)`;
  const job = startSupervisedJob(isolated(directory, {
    command: { program: process.execPath, args: ["-e", program], timeoutSeconds: 10 },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  }), join(directory, "input.json"));
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

test("refuses a persisted JobInput whose controller digest does not match", async () => {
  const directory = tempDir("aec-s-job-integrity-");
  const inputPath = join(directory, "input.json");
  const input = isolated(directory, {
    command: { program: process.execPath, args: ["-e", "process.exit(0)"] },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    resultPath: join(directory, "result.json"),
  });
  writeJsonAtomic(inputPath, input);
  await assert.rejects(runJobFile(inputPath, "0".repeat(64)), /integrity check failed/);
  assert.equal(existsSync(input.resultPath), false);
});
