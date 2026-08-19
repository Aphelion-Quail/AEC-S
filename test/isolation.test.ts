import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { probeProcessIsolation } from "../src/isolation.js";
import { startSupervisedJob, waitForJob } from "../src/job.js";
import { tempDir } from "./helpers.js";

const macOnly = { skip: process.platform !== "darwin" };

test("proves the required macOS process isolation primitive", macOnly, () => {
  assert.equal(probeProcessIsolation().ok, true);
});

test("confines an entire Runtime process tree to its declared filesystem paths", macOnly, async () => {
  const root = tempDir("aec-s-isolation-");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  const runtimeState = join(root, "runtime-state");
  const outside = join(root, "private.txt");
  const escapedWrite = join(root, "escaped.txt");
  for (const path of [workspace, controller, runtimeState]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(outside, "private", { mode: 0o600 });
  writeFileSync(join(runtimeState, "auth-state"), "runtime-only", { mode: 0o600 });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  assert.ok(unrelated.pid);
  const program = `
    const {spawnSync}=require('node:child_process');
    const fs=require('node:fs');
    const read=(path)=>{try{return fs.readFileSync(path,'utf8')}catch(error){return error.code}};
    const write=(path)=>{try{fs.writeFileSync(path,'x');return 'allowed'}catch(error){return error.code}};
    const child=spawnSync(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');try{fs.readFileSync(process.argv[1]);process.stdout.write('leaked')}catch(e){process.stdout.write(e.code)}")},${JSON.stringify(outside)}],{encoding:'utf8'});
    const signal=()=>{try{process.kill(${unrelated.pid},'SIGCONT');return 'allowed'}catch(error){return error.code}};
    process.stdout.write(JSON.stringify({outside:read(${JSON.stringify(outside)}),runtime:read(${JSON.stringify(join(runtimeState, "auth-state"))}),escaped:write(${JSON.stringify(escapedWrite)}),workspace:write(${JSON.stringify(join(workspace, "allowed.txt"))}),child:child.stdout,signal:signal(),ssh:process.env.SSH_AUTH_SOCK,home:process.env.HOME}));
  `;
  const inputPath = join(controller, "job.input.json");
  const stdoutPath = join(controller, "stdout.log");
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 10 },
    environmentProfile: "codex",
    isolation: {
      workspacePath: workspace,
      mode: "workspace-write",
      controllerPath: controller,
      runtimeStatePaths: [runtimeState],
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, inputPath);
  try {
    assert.equal((await waitForJob(job, 15)).exitCode, 0);
    const result = JSON.parse(readFileSync(stdoutPath, "utf8")) as Record<string, string>;
    assert.equal(result.outside, "EPERM");
    assert.equal(result.child, "EPERM");
    assert.equal(result.runtime, "runtime-only");
    assert.equal(result.escaped, "EPERM");
    assert.equal(result.workspace, "allowed");
    assert.equal(result.signal, "EPERM");
    assert.equal(result.ssh, "");
    assert.equal(result.home, join(controller, "home"));
    assert.equal(existsSync(escapedWrite), false);
  } finally {
    unrelated.kill("SIGKILL");
  }
});

test("adds an outer read-only boundary around Reviewer worktrees", macOnly, async () => {
  const root = tempDir("aec-s-review-isolation-");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(controller, { recursive: true });
  const stdoutPath = join(controller, "stdout.log");
  const job = startSupervisedJob({
    command: {
      program: process.execPath,
      args: ["-e", `try{require('node:fs').writeFileSync(${JSON.stringify(join(workspace, "mutation"))},'x');process.stdout.write('allowed')}catch(error){process.stdout.write(error.code)}`],
      cwd: workspace,
      timeoutSeconds: 10,
    },
    isolation: {
      workspacePath: workspace,
      mode: "read-only",
      controllerPath: controller,
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, join(controller, "input.json"));
  assert.equal((await waitForJob(job, 15)).exitCode, 0);
  assert.equal(readFileSync(stdoutPath, "utf8"), "EPERM");
});
