import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  gitMetadataReadPaths,
  isolationEnvironment,
  probeProcessIsolation,
  runtimeAccessPaths,
} from "../src/isolation.js";
import { startSupervisedJob, waitForJob } from "../src/job.js";
import { createGitRepository, tempDir } from "./helpers.js";

const macOnly = { skip: process.platform !== "darwin" };

test("proves the required macOS process isolation primitive", macOnly, () => {
  assert.equal(probeProcessIsolation().ok, true);
});

test("maps Kimi authentication into isolated HOME with explicit Runtime state grants", () => {
  const root = tempDir("aec-s-kimi-isolated-home-");
  const share = join(root, ".kimi-code");
  const controller = join(root, "controller");
  mkdirSync(share, { recursive: true });
  const isolation = {
    workspacePath: root,
    mode: "read-only" as const,
    networkAccess: "provider" as const,
    controllerPath: controller,
    runtimeOutputPath: join(controller, "runtime-output"),
    credentialReadPaths: [share],
    stateWritePaths: [join(share, "sessions")],
    homePath: join(controller, "home"),
    tempPath: join(controller, "tmp"),
  };
  const environment = isolationEnvironment(isolation, "kimi");
  assert.equal(environment.HOME, isolation.homePath);
  assert.equal(environment.KIMI_SHARE_DIR, share);
  assert.equal(realpathSync(join(isolation.homePath, ".kimi-code")), realpathSync(share));
  assert.deepEqual(isolation.stateWritePaths, [join(share, "sessions")]);
});

test("references the authorized DSH credential root from isolated HOME", () => {
  const root = tempDir("aec-s-dsh-isolated-home-");
  const dshHome = join(root, ".dsh");
  const controller = join(root, "controller");
  mkdirSync(dshHome, { recursive: true });
  const environment = isolationEnvironment({
    workspacePath: root,
    mode: "read-only",
    networkAccess: "provider",
    controllerPath: controller,
    runtimeOutputPath: join(controller, "runtime-output"),
    credentialReadPaths: [dshHome],
    stateWritePaths: [join(dshHome, "sessions")],
    homePath: join(controller, "home"),
    tempPath: join(controller, "tmp"),
  }, "deepseek_harness");
  assert.equal(environment.HOME, join(controller, "home"));
  assert.equal(environment.DSH_HOME, dshHome);
});

test("classifies Codex mutable state separately from credential files", () => {
  const root = tempDir("aec-s-codex-state-paths-");
  const paths = runtimeAccessPaths("codex", [root]);
  const canonicalRoot = realpathSync(root);
  assert.ok(paths.stateWritePaths.includes(canonicalRoot));
  assert.ok(paths.stateWritePaths.includes(join(canonicalRoot, "state_5.sqlite")));
  assert.ok(paths.stateWritePaths.includes(join(canonicalRoot, "thread-writer-locks")));
  assert.equal(paths.stateWritePaths.includes(join(canonicalRoot, "auth.json")), false);
  assert.equal(paths.stateWritePaths.includes(join(canonicalRoot, "config.toml")), false);
});

test("allows Codex dynamic state while denying credential and policy mutation", macOnly, async () => {
  const root = tempDir("aec-s-codex-credential-boundary-");
  const runtimeRoot = join(root, "custom-codex-runtime-home");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  for (const path of [runtimeRoot, workspace, controller]) mkdirSync(path, { recursive: true });
  const auth = join(runtimeRoot, "auth.json");
  const config = join(runtimeRoot, "config.toml");
  writeFileSync(auth, "credential");
  writeFileSync(config, "policy");
  const access = runtimeAccessPaths("codex", [runtimeRoot]);
  const stdoutPath = join(controller, "stdout.log");
  const program = `
    const fs=require('node:fs');
    const write=(path)=>{try{fs.writeFileSync(path,'changed');return 'allowed'}catch(error){return error.code}};
    process.stdout.write(JSON.stringify({
      state:write(${JSON.stringify(join(runtimeRoot, "dynamic-state.tmp"))}),
      auth:write(${JSON.stringify(auth)}),
      config:write(${JSON.stringify(config)})
    }));
  `;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 10 },
    environmentProfile: "codex",
    isolation: {
      workspacePath: workspace,
      mode: "read-only",
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
      credentialReadPaths: access.credentialReadPaths,
      stateWritePaths: access.stateWritePaths,
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, join(controller, "input.json"));
  assert.equal((await waitForJob(job, 15)).exitCode, 0);
  const result = JSON.parse(readFileSync(stdoutPath, "utf8")) as { state: string; auth: string; config: string };
  assert.equal(result.state, "allowed");
  assert.equal(result.auth, "EPERM");
  assert.equal(result.config, "EPERM");
  assert.equal(readFileSync(auth, "utf8"), "credential");
  assert.equal(readFileSync(config, "utf8"), "policy");
});

test("allows Kimi-owned credential refresh while denying policy and binary mutation", macOnly, async () => {
  const root = tempDir("aec-s-kimi-credential-boundary-");
  const runtimeRoot = join(root, ".kimi-code");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  const binaryDirectory = join(runtimeRoot, "bin");
  const credentialDirectory = join(runtimeRoot, "credentials");
  const oauthDirectory = join(runtimeRoot, "oauth");
  for (const path of [runtimeRoot, workspace, controller, binaryDirectory, credentialDirectory, oauthDirectory]) {
    mkdirSync(path, { recursive: true });
  }
  const credential = join(credentialDirectory, "kimi-code.json");
  const config = join(runtimeRoot, "config.toml");
  const binary = join(binaryDirectory, "kimi");
  writeFileSync(credential, "credential");
  writeFileSync(config, "policy");
  writeFileSync(binary, "binary");
  const access = runtimeAccessPaths("kimi", [runtimeRoot]);
  const stdoutPath = join(controller, "stdout.log");
  const program = `
    const fs=require('node:fs');
    const write=(path)=>{try{fs.writeFileSync(path,'changed');return 'allowed'}catch(error){return error.code}};
    process.stdout.write(JSON.stringify({
      state:write(${JSON.stringify(join(runtimeRoot, "dynamic-state.tmp"))}),
      oauth:write(${JSON.stringify(join(oauthDirectory, "kimi-code"))}),
      credential:write(${JSON.stringify(credential)}),
      config:write(${JSON.stringify(config)}),
      binary:write(${JSON.stringify(binary)})
    }));
  `;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 10 },
    environmentProfile: "kimi",
    isolation: {
      workspacePath: workspace,
      mode: "read-only",
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
      credentialReadPaths: access.credentialReadPaths,
      stateWritePaths: access.stateWritePaths,
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, join(controller, "input.json"));
  assert.equal((await waitForJob(job, 15)).exitCode, 0);
  const result = JSON.parse(readFileSync(stdoutPath, "utf8")) as {
    state: string; oauth: string; credential: string; config: string; binary: string;
  };
  assert.equal(result.state, "allowed");
  assert.equal(result.oauth, "allowed");
  assert.equal(result.credential, "allowed");
  assert.equal(result.config, "EPERM");
  assert.equal(result.binary, "EPERM");
});

test("confines an entire Runtime process tree to its declared filesystem paths", macOnly, async () => {
  const root = tempDir("aec-s-isolation-");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  const runtimeState = join(root, "runtime-state");
  const runtimeSessions = join(runtimeState, "sessions");
  const outside = join(root, "private.txt");
  const escapedWrite = join(root, "escaped.txt");
  for (const path of [workspace, controller, runtimeSessions]) mkdirSync(path, { recursive: true, mode: 0o700 });
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
    process.stdout.write(JSON.stringify({outside:read(${JSON.stringify(outside)}),runtime:read(${JSON.stringify(join(runtimeState, "auth-state"))}),credentialWrite:write(${JSON.stringify(join(runtimeState, "auth-state"))}),stateWrite:write(${JSON.stringify(join(runtimeSessions, "session.json"))}),controllerWrite:write(${JSON.stringify(join(controller, "forged-result.json"))}),escaped:write(${JSON.stringify(escapedWrite)}),workspace:write(${JSON.stringify(join(workspace, "allowed.txt"))}),child:child.stdout,signal:signal(),ssh:process.env.SSH_AUTH_SOCK,home:process.env.HOME}));
  `;
  const inputPath = join(controller, "job.input.json");
  const stdoutPath = join(controller, "stdout.log");
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 10 },
    environmentProfile: "codex",
    isolation: {
      workspacePath: workspace,
      mode: "workspace-write",
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
      credentialReadPaths: [runtimeState],
      stateWritePaths: [runtimeSessions],
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
    assert.equal(result.credentialWrite, "EPERM");
    assert.equal(result.stateWrite, "allowed");
    assert.equal(result.controllerWrite, "EPERM");
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
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
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

test("confines packet-only DSH Review to controller evidence", macOnly, async () => {
  const root = tempDir("aec-s-dsh-review-packet-");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  const evidence = join(root, "review-packet");
  for (const path of [workspace, controller, evidence]) mkdirSync(path, { recursive: true });
  const source = join(workspace, "source.ts");
  const packet = join(evidence, "review.json");
  writeFileSync(source, "private workspace source");
  writeFileSync(packet, "authorized review packet");
  const stdoutPath = join(controller, "stdout.log");
  const program = `
    const fs=require('node:fs');
    const read=(path)=>{try{return fs.readFileSync(path,'utf8')}catch(error){return error.code}};
    process.stdout.write(JSON.stringify({source:read(${JSON.stringify(source)}),packet:read(${JSON.stringify(packet)})}));
  `;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 10 },
    environmentProfile: "deepseek_harness",
    isolation: {
      workspacePath: workspace,
      workspaceAccess: "metadata",
      mode: "read-only",
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
      evidenceReadPaths: [evidence],
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, join(controller, "input.json"));
  assert.equal((await waitForJob(job, 15)).exitCode, 0);
  const result = JSON.parse(readFileSync(stdoutPath, "utf8")) as { source: string; packet: string };
  assert.equal(result.source, "EPERM");
  assert.equal(result.packet, "authorized review packet");
});

test("denies network access unless a first-class Runtime receives the explicit provider exception", macOnly, async () => {
  const root = tempDir("aec-s-network-isolation-");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(controller, { recursive: true });
  const server = createServer((socket) => {
    socket.on("error", () => { /* A denied sandbox connection may reset after accept. */ });
    socket.end("unexpected");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const stdoutPath = join(controller, "stdout.log");
  const program = `
    const net=require('node:net');
    const socket=net.connect(${address.port},'127.0.0.1');
    socket.once('connect',()=>{process.stdout.write('allowed');socket.destroy()});
    socket.once('error',(error)=>process.stdout.write(error.code||error.message));
    setTimeout(()=>{process.stdout.write('timeout');socket.destroy()},1000).unref();
  `;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 5 },
    isolation: {
      workspacePath: workspace,
      mode: "read-only",
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, join(controller, "input.json"));
  try {
    assert.equal((await waitForJob(job, 10)).exitCode, 0);
    assert.match(readFileSync(stdoutPath, "utf8"), /EPERM|EACCES/);
    const providerStdout = join(controller, "provider.stdout.log");
    const providerJob = startSupervisedJob({
      command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 5 },
      isolation: {
        workspacePath: workspace,
        mode: "read-only",
        networkAccess: "provider",
        controllerPath: controller,
        runtimeOutputPath: join(controller, "provider-runtime-output"),
        homePath: join(controller, "provider-home"),
        tempPath: join(controller, "provider-tmp"),
      },
      stdoutPath: providerStdout,
      stderrPath: join(controller, "provider.stderr.log"),
      resultPath: join(controller, "provider.result.json"),
    }, join(controller, "provider.input.json"));
    assert.equal((await waitForJob(providerJob, 10)).exitCode, 0);
    assert.equal(readFileSync(providerStdout, "utf8"), "allowed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("allows Git evidence reads while denying Runtime writes to Project metadata", macOnly, async () => {
  const repo = createGitRepository();
  const root = tempDir("aec-s-git-isolation-");
  const workspace = join(root, "workspace");
  const controller = join(root, "controller");
  mkdirSync(controller, { recursive: true, mode: 0o700 });
  execFileSync("git", ["worktree", "add", "-b", "isolation-test", workspace], { cwd: repo, stdio: "ignore" });
  const metadata = gitMetadataReadPaths(workspace, repo);
  const unrelated = createGitRepository();
  assert.throws(() => gitMetadataReadPaths(workspace, unrelated), /does not belong/);
  const stdoutPath = join(controller, "stdout.log");
  const program = `
    const {spawnSync}=require('node:child_process');
    const fs=require('node:fs');
    fs.writeFileSync('allowed.txt','ok');
    const status=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
    const add=spawnSync('git',['add','--','allowed.txt'],{encoding:'utf8'});
    process.stdout.write(JSON.stringify({status:status.status,add:add.status,stderr:add.stderr}));
  `;
  const job = startSupervisedJob({
    command: { program: process.execPath, args: ["-e", program], cwd: workspace, timeoutSeconds: 10 },
    isolation: {
      workspacePath: workspace,
      mode: "workspace-write",
      networkAccess: "none",
      controllerPath: controller,
      runtimeOutputPath: join(controller, "runtime-output"),
      gitMetadataPaths: metadata,
      homePath: join(controller, "home"),
      tempPath: join(controller, "tmp"),
    },
    stdoutPath,
    stderrPath: join(controller, "stderr.log"),
    resultPath: join(controller, "result.json"),
  }, join(controller, "input.json"));
  assert.equal((await waitForJob(job, 15)).exitCode, 0);
  const result = JSON.parse(readFileSync(stdoutPath, "utf8")) as { status: number; add: number; stderr: string };
  assert.equal(result.status, 0);
  assert.notEqual(result.add, 0);
  assert.match(result.stderr, /operation not permitted/i);
});
