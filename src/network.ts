import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, connect as connectSocket, createServer as createTcpServer, type Socket } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { AecSDatabase } from "./db.js";
import { fingerprint } from "./fingerprint.js";
import { writeJsonAtomic } from "./files.js";
import { newId } from "./ids.js";
import { cancelSupervisedJob, startSupervisedJob, waitForJob } from "./job.js";
import { redactText } from "./redaction.js";
import type { Agent, JobInput, Project, Run, Task, Workspace } from "./types.js";

const LOOPBACK = "127.0.0.1";
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_HEADER_BYTES = 16 * 1024;
const CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["2001:db8::", 32], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

function hostName(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error("Network host must be an exact public DNS hostname");
  }
  if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("IP, loopback, and local network destinations are forbidden");
  }
  return host;
}

async function publicAddresses(host: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Network host did not resolve");
  for (const address of addresses) {
    const family = address.family === 6 ? "ipv6" : "ipv4";
    if (blockedAddresses.check(address.address, family)) throw new Error("Private or reserved network destination is forbidden");
  }
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

function listen(server: HttpServer | ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Loopback broker did not expose a TCP port"));
      resolvePromise(address.port);
    });
  });
}

function closeServer(server: HttpServer | ReturnType<typeof createTcpServer>): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function rejectProxy(socket: Socket, status = "403 Forbidden"): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export type LoopbackProxy = { port: number; url: string; close(): Promise<void> };

export async function startHttpsConnectProxy(allowedHostsInput: string[]): Promise<LoopbackProxy> {
  const allowedHosts = new Set(allowedHostsInput.map(hostName));
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    sockets.add(client);
    let upstream: Socket | undefined;
    client.on("error", () => {
      if (upstream && !upstream.destroyed) upstream.destroy();
    });
    client.once("close", () => {
      sockets.delete(client);
      if (upstream && !upstream.destroyed) upstream.destroy();
    });
    let header = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > MAX_PROXY_HEADER_BYTES) return rejectProxy(client, "431 Request Header Fields Too Large");
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const [line] = header.subarray(0, end).toString("latin1").split("\r\n");
      const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/.exec(line ?? "");
      if (!match?.[1] || Number(match[2]) !== 443) return rejectProxy(client);
      let host: string;
      try { host = hostName(match[1]); } catch { return rejectProxy(client); }
      if (!allowedHosts.has(host)) return rejectProxy(client);
      try {
        const [target] = await publicAddresses(host);
        if (!target) return rejectProxy(client, "502 Bad Gateway");
        if (client.destroyed) return;
        upstream = connectSocket({ host: target.address, port: 443, family: target.family });
        sockets.add(upstream);
        let tunnelEstablished = false;
        upstream.on("error", () => {
          if (!tunnelEstablished && !client.destroyed) rejectProxy(client, "502 Bad Gateway");
          else if (!client.destroyed) client.destroy();
        });
        upstream.once("close", () => {
          if (upstream) sockets.delete(upstream);
          if (!client.destroyed) client.destroy();
        });
        upstream.once("connect", () => {
          if (client.destroyed || !upstream) {
            upstream?.destroy();
            return;
          }
          tunnelEstablished = true;
          // The 30 second timeout protects only the unauthenticated CONNECT
          // handshake. Provider inference may legitimately be quiet for much
          // longer, so an established tunnel must not inherit that deadline.
          client.setTimeout(0);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remainder = header.subarray(end + 4);
          if (remainder.length > 0) upstream.write(remainder);
          client.pipe(upstream).pipe(client);
        });
      } catch { rejectProxy(client, "502 Bad Gateway"); }
    };
    client.on("data", onData);
    client.setTimeout(30_000, () => client.destroy());
  });
  const port = await listen(server);
  return { port, url: `http://${LOOPBACK}:${port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await closeServer(server);
  } };
}

export function providerHosts(agent: Agent): string[] {
  if (agent.adapter === "codex") return ["api.openai.com", "auth.openai.com", "chatgpt.com", "ab.chatgpt.com"];
  if (agent.adapter === "kimi") return ["api.kimi.com", "auth.kimi.com", "cdn.kimi.com", "code.kimi.com"];
  if (agent.adapter === "deepseek_harness") return ["api.deepseek.com"];
  return [];
}

async function fetchPublic(urlText: string, method: "GET" | "HEAD", redirects = 0): Promise<{
  host: string; status: number; contentType?: string; body: string; bytes: number;
}> {
  const url = new URL(urlText);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password) {
    throw new Error("aec_s_fetch only accepts unauthenticated HTTPS URLs on port 443");
  }
  const host = hostName(url.hostname);
  const addresses = await publicAddresses(host);
  let selected = 0;
  const agent = new HttpsAgent({
    lookup: (_hostname, _options, callback) => {
      const address = addresses[Math.min(selected++, addresses.length - 1)]!;
      callback(null, address.address, address.family);
    },
  });
  return await new Promise((resolvePromise, reject) => {
    const request = httpsRequest(url, {
      method,
      agent,
      headers: { "user-agent": "AEC-S/1.0 fetch", accept: "*/*" },
      timeout: 30_000,
    }, (response) => {
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("aec_s_fetch response was aborted")));
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(new Error("aec_s_fetch redirect limit exceeded"));
        const redirected = new URL(response.headers.location, url);
        if (redirected.hostname.toLowerCase().replace(/\.$/, "") !== host) {
          return reject(new Error("aec_s_fetch rejects cross-origin redirects"));
        }
        void fetchPublic(redirected.href, method, redirects + 1).then(resolvePromise, reject);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_FETCH_BYTES) {
          request.destroy(new Error("aec_s_fetch response exceeds 8 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolvePromise({
        host,
        status,
        ...(typeof response.headers["content-type"] === "string" ? { contentType: response.headers["content-type"] } : {}),
        body: method === "HEAD" ? "" : Buffer.concat(chunks).toString("utf8"),
        bytes,
      }));
    });
    request.once("timeout", () => request.destroy(new Error("aec_s_fetch timed out")));
    request.once("error", reject);
    request.end();
  });
}

function inside(root: string, path: string): boolean {
  const child = relative(realpathSync(root), realpathSync(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep));
}

const NETWORK_ACTIONS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["ci", "install", "view", "info", "search", "outdated", "pack"]),
  pnpm: new Set(["install", "fetch", "view", "info", "outdated"]),
  yarn: new Set(["install", "info"]),
  bun: new Set(["install"]),
  cargo: new Set(["fetch", "search", "info", "update"]),
  go: new Set(["list", "mod"]),
  pip: new Set(["download", "index"]),
  pip3: new Set(["download", "index"]),
};

function assertNetworkCommand(program: string, args: string[]): void {
  const action = args[0];
  if (!action || !NETWORK_ACTIONS[program]?.has(action) || args.some((argument) => /^(?:ssh|git\+ssh):/i.test(argument))) {
    throw new Error("network_exec command is outside the dependency-read/install authority");
  }
  if (program === "go" && action === "mod" && args[args.indexOf(action) + 1] !== "download") {
    throw new Error("network_exec only permits go mod download");
  }
}

function hardenedNetworkArgs(program: string, args: string[]): string[] {
  if (["npm", "pnpm", "bun"].includes(program) && ["ci", "install"].includes(args[0] ?? "")) {
    return [...args, "--ignore-scripts"];
  }
  if (["pip", "pip3"].includes(program) && args[0] === "download") return [...args, "--only-binary=:all:"];
  return args;
}

function assertNoDependencyCredentials(workspace: string): void {
  for (const relativePath of [".npmrc", ".yarnrc", ".yarnrc.yml", "pip.conf", ".cargo/credentials", ".cargo/credentials.toml", ".netrc"]) {
    const path = join(workspace, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const content = readFileSync(path, "utf8").slice(0, 1024 * 1024);
    if (/(?:_auth|authToken|npmAuthToken|password|credential|token)\s*[:=]|machine\s+\S+\s+login\s+/i.test(content)) {
      throw new Error(`network_exec refuses credential-bearing project package configuration: ${relativePath}`);
    }
  }
}

type RunGatewayOptions = {
  db: AecSDatabase;
  run: Run;
  task: Task;
  project: Project;
  workspace: Workspace;
  role: "executor" | "reviewer";
  dependencyProxy?: LoopbackProxy;
  expiresAt?: number;
};

export type RunNetworkGateway = {
  port: number;
  url: string;
  token: string;
  capabilityPath: string;
  policyDigest: string;
  close(): Promise<void>;
};

function mcpResult(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

export async function startRunNetworkGateway(options: RunGatewayOptions): Promise<RunNetworkGateway> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = options.expiresAt ?? Date.now() + CAPABILITY_TTL_MS;
  const policy = options.project.operationalConfig?.networkPolicy ?? { mode: "brokered" as const, dependencyHosts: [] };
  const policyDigest = fingerprint({
    mode: policy.mode,
    dependencyHosts: [...policy.dependencyHosts].sort(),
    runId: options.run.id,
    taskRevisionId: options.run.taskRevisionId,
    role: options.role,
    scope: options.task.scope,
    expiresAt,
  });
  const capabilityPath = join(options.run.logDir, "control", `network-capability-${newId("run")}.json`);
  const controlDirectory = join(options.run.logDir, "control");
  if (existsSync(controlDirectory)) {
    for (const filename of readdirSync(controlDirectory)) {
      if (!filename.startsWith("network-capability-") || !filename.endsWith(".json")) continue;
      try { unlinkSync(join(controlDirectory, filename)); } catch { /* A concurrent fenced owner may have consumed it. */ }
    }
  }
  writeJsonAtomic(capabilityPath, { AEC_S_RUN_MCP_TOKEN: token });
  const activeNetworkJobs = new Set<number>();
  const app = createMcpExpressApp({ host: LOOPBACK });
  app.post("/mcp", async (
    request: IncomingMessage & { body?: unknown },
    response: ServerResponse & { status(code: number): { json(value: unknown): void } },
  ) => {
    const supplied = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const suppliedBytes = Buffer.from(supplied ?? "");
    const tokenBytes = Buffer.from(token);
    if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes) || Date.now() >= expiresAt) {
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Expired or invalid Run capability" }, id: null });
      return;
    }
    const server = new McpServer({ name: "aec-s-run-network", version: "1.0" });
    server.registerTool("aec_s_fetch", {
      description: "Read a small public HTTPS resource without Runtime credentials.",
      inputSchema: z.object({ url: z.string().url().max(8_192), method: z.enum(["GET", "HEAD"]).default("GET") }).strict(),
    }, async ({ url, method }) => {
      let host = "invalid";
      try {
        host = new URL(url).hostname.toLowerCase();
        const fetched = await fetchPublic(url, method);
        options.db.appendEvent({ projectId: options.project.id, taskId: options.task.id, runId: options.run.id,
          type: "network.fetch", payload: { host: fetched.host, operation: method, result: fetched.status, bytes: fetched.bytes } });
        return mcpResult({ status: fetched.status, contentType: fetched.contentType ?? null, body: fetched.body, bytes: fetched.bytes });
      } catch (error) {
        options.db.appendEvent({ projectId: options.project.id, taskId: options.task.id, runId: options.run.id,
          type: "network.fetch", payload: { host, operation: method, result: "rejected", bytes: 0 } });
        throw error;
      }
    });
    if (options.role === "executor") {
      server.registerTool("aec_s_network_exec", {
        description: "Run a credential-free package/dependency command through Project-approved repositories.",
        inputSchema: z.object({
          program: z.string().min(1).max(64), args: z.array(z.string().max(4_096)).max(256),
          cwd: z.string().max(4_096).optional(), timeoutSeconds: z.number().int().min(1).max(1_800).default(300),
        }).strict(),
      }, async ({ program, args, cwd, timeoutSeconds }) => {
        assertNetworkCommand(program, args);
        if (!options.dependencyProxy || policy.dependencyHosts.length === 0) throw new Error("Project has no detected dependency hosts");
        assertNoDependencyCredentials(options.workspace.path);
        const commandCwd = resolve(options.workspace.path, cwd ?? ".");
        if (!existsSync(commandCwd) || !inside(options.workspace.path, commandCwd)) throw new Error("network_exec cwd escapes the Run workspace");
        const jobId = newId("network");
        const directory = join(options.run.logDir, "control", jobId);
        const proxyUrl = options.dependencyProxy.url;
        const input: JobInput = {
          command: { program, args: hardenedNetworkArgs(program, args), cwd: commandCwd, timeoutSeconds, env: {
            HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: "", NODE_USE_ENV_PROXY: "1",
            GH_TOKEN: "", GITHUB_TOKEN: "", SSH_AUTH_SOCK: "",
            NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
            YARN_ENABLE_SCRIPTS: "false",
          } },
          environmentProfile: "restricted",
          isolation: {
            workspacePath: options.workspace.path, workspaceAccess: "full", mode: "workspace-write", networkAccess: "provider",
            loopbackPorts: [options.dependencyProxy.port], controllerPath: options.run.logDir,
            runtimeOutputPath: join(directory, "runtime-output"), credentialReadPaths: [], stateWritePaths: [], gitMetadataPaths: [],
            homePath: join(directory, "home"), tempPath: join(directory, "tmp"),
          },
          stdoutPath: join(directory, "stdout.log"), stderrPath: join(directory, "stderr.log"), resultPath: join(directory, "result.json"),
        };
        const job = startSupervisedJob(input, join(directory, "input.json"), jobId);
        if (job.pid) activeNetworkJobs.add(job.pid);
        const result = await waitForJob(job, timeoutSeconds).finally(() => { if (job.pid) activeNetworkJobs.delete(job.pid); });
        const stdout = existsSync(input.stdoutPath) ? redactText(await (await import("node:fs/promises")).readFile(input.stdoutPath, "utf8")) : "";
        const stderr = existsSync(input.stderrPath) ? redactText(await (await import("node:fs/promises")).readFile(input.stderrPath, "utf8")) : "";
        const host = policy.dependencyHosts.join(",");
        options.db.appendEvent({ projectId: options.project.id, taskId: options.task.id, runId: options.run.id,
          type: "network.exec", payload: { host, operation: program, result: result.status, bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr) } });
        return mcpResult({ status: result.status, exitCode: result.exitCode, stdout, stderr });
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  const httpServer = app.listen(0, LOOPBACK);
  const port = await new Promise<number>((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.once("listening", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") reject(new Error("Run Gateway did not expose a loopback port"));
      else resolvePromise(address.port);
    });
  });
  return {
    port, url: `http://${LOOPBACK}:${port}/mcp`, token, capabilityPath, policyDigest,
    close: async () => {
      try { unlinkSync(capabilityPath); } catch { /* Already consumed or expired. */ }
      for (const pid of activeNetworkJobs) cancelSupervisedJob(pid);
      activeNetworkJobs.clear();
      await closeServer(httpServer);
    },
  };
}
