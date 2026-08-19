#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AecSDatabase } from "./db.js";
import { AecSEngine } from "./engine.js";
import { assertGitRepository } from "./git.js";
import { runJobFile } from "./job.js";
import { serveMcp, serveMcpHttp } from "./mcp.js";
import { doctor } from "./doctor.js";
import { serviceAction } from "./service.js";
import { systemOutboxLoop } from "./outbox.js";
import { initializeAecS, inspectProject } from "./onboarding.js";
import { redactText } from "./redaction.js";
import {
  agentInputSchema,
  agentUpdateSchema,
  decisionInputSchema,
  directiveSchema,
  projectInputSchema,
  projectUpdateSchema,
  resolutionSchema,
  taskGraphSchema,
} from "./input.js";

function readInput(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assertConfiguredRepositoryPath(repoPath: string): void {
  const normalized = repoPath.replaceAll("\\", "/");
  if (normalized === "__AEC_S_REPOSITORY_PATH_REQUIRED__" || normalized.startsWith("/absolute/path/to/")) {
    throw new Error("Project repoPath is still an example placeholder; replace it with the absolute path of a trusted Git repository");
  }
}

function usage(): never {
  process.stderr.write(`AEC-S commands:
  aec-s project <add|list|show|update> [...]
  aec-s project import <path> [--apply]
  aec-s agent <add|list|show|update> [...]
  aec-s graph submit <graph.json>
  aec-s run [task-id]
  aec-s daemon
  aec-s status [project-id]
  aec-s task <pause|resume|cancel> <task-id>
  aec-s directive apply <directive.json>
  aec-s decision <list|show|resolve|record> [...]
  aec-s service <install|start|stop|restart|status|uninstall>
  aec-s doctor
  aec-s init [--no-service]
  aec-s mcp
  aec-s mcp-http
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, subcommand, ...args] = process.argv.slice(2);
  if (command === "internal-job") {
    if (!subcommand) usage();
    await runJobFile(subcommand);
    return;
  }
  if (command === "init") {
    output(await initializeAecS({ installService: !process.argv.slice(2).includes("--no-service") }));
    return;
  }
  const db = new AecSDatabase();
  const engine = new AecSEngine(db);
  try {
    if (command === "project" && subcommand === "add") {
      const path = args[0] ?? usage();
      const input = projectInputSchema.parse(readInput(path));
      assertConfiguredRepositoryPath(input.repoPath);
      input.repoPath = resolve(input.repoPath);
      await assertGitRepository(input.repoPath);
      output(db.createProject(input));
    } else if (command === "project" && subcommand === "list") {
      output({ projects: db.listProjects() });
    } else if (command === "project" && subcommand === "show") {
      const project = db.getProject(args[0] ?? usage());
      if (!project) throw new Error(`Unknown project: ${args[0]}`);
      output(project);
    } else if (command === "project" && subcommand === "update") {
      output(db.updateProject(args[0] ?? usage(), projectUpdateSchema.parse(readInput(args[1] ?? usage()))));
    } else if (command === "project" && subcommand === "import") {
      const inspected = await inspectProject(args[0] ?? usage());
      if (args.includes("--apply")) {
        await assertGitRepository(inspected.project.repoPath);
        output({ ...inspected, project: db.createProject(projectInputSchema.parse(inspected.project)) });
      } else {
        output(inspected);
      }
    } else if (command === "agent" && subcommand === "add") {
      output(db.createAgent(agentInputSchema.parse(readInput(args[0] ?? usage()))));
    } else if (command === "agent" && subcommand === "list") {
      output({ agents: db.listAgents() });
    } else if (command === "agent" && subcommand === "show") {
      const agent = db.getAgent(args[0] ?? usage());
      if (!agent) throw new Error(`Unknown agent: ${args[0]}`);
      output(agent);
    } else if (command === "agent" && subcommand === "update") {
      output(db.updateAgent(args[0] ?? usage(), agentUpdateSchema.parse(readInput(args[1] ?? usage()))));
    } else if (command === "graph" && subcommand === "submit") {
      const value = taskGraphSchema.parse(readInput(args[0] ?? usage()));
      output({ tasks: engine.submitGraph(value.projectId, value.tasks) });
    } else if (command === "run") {
      if (subcommand) await engine.runTask(subcommand);
      else await engine.runUntilIdle();
      output(db.statusSnapshot());
    } else if (command === "daemon") {
      const controller = new AbortController();
      process.on("SIGTERM", () => controller.abort());
      process.on("SIGINT", () => controller.abort());
      const services = [
        engine.daemon(controller.signal),
        serveMcpHttp(db, { signal: controller.signal }),
        systemOutboxLoop(db, controller.signal),
      ];
      const first = await Promise.race(services.map(async (service) => {
        try { await service; return { ok: true as const }; }
        catch (error) { return { ok: false as const, error }; }
      }));
      const requestedStop = controller.signal.aborted;
      controller.abort();
      await Promise.allSettled(services);
      if (!first.ok) throw first.error;
      if (!requestedStop) throw new Error("An AEC-S daemon component stopped unexpectedly");
    } else if (command === "status") {
      output(db.statusSnapshot(subcommand));
    } else if (command === "task" && ["pause", "resume", "cancel"].includes(subcommand ?? "")) {
      const taskId = args[0] ?? usage();
      output({ tasks: engine.applyDirective({ action: subcommand as "pause" | "resume" | "cancel", taskIds: [taskId] }) });
    } else if (command === "directive" && subcommand === "apply") {
      output({ tasks: engine.applyDirective(directiveSchema.parse(readInput(args[0] ?? usage()))) });
    } else if (command === "decision" && subcommand === "list") {
      output({ decisions: db.listDecisions(args[0]) });
    } else if (command === "decision" && subcommand === "show") {
      const decision = db.getDecision(args[0] ?? usage());
      if (!decision) throw new Error(`Unknown decision: ${args[0]}`);
      output(decision);
    } else if (command === "decision" && subcommand === "resolve") {
      output(engine.resolveDecision(args[0] ?? usage(), resolutionSchema.parse(readInput(args[1] ?? usage()))));
    } else if (command === "decision" && subcommand === "record") {
      output(db.createDecision({ ...decisionInputSchema.parse(readInput(args[0] ?? usage())), status: "resolved" }));
    } else if (command === "service" && ["install", "start", "stop", "restart", "status", "uninstall"].includes(subcommand ?? "")) {
      output({ message: await serviceAction(subcommand as "install" | "start" | "stop" | "restart" | "status" | "uninstall", db.paths) });
    } else if (command === "doctor") {
      output(await doctor(db));
    } else if (command === "mcp") {
      await serveMcp(db);
    } else if (command === "mcp-http") {
      const controller = new AbortController();
      process.on("SIGTERM", () => controller.abort());
      process.on("SIGINT", () => controller.abort());
      await serveMcpHttp(db, { signal: controller.signal });
    } else {
      usage();
    }
  } finally {
    if (command !== "mcp" && command !== "mcp-http" && command !== "daemon") db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${redactText(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
