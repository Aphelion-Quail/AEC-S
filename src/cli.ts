#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AecDatabase } from "./db.js";
import { AecEngine } from "./engine.js";
import { assertGitRepository } from "./git.js";
import { runJobFile } from "./job.js";
import { serveMcp } from "./mcp.js";
import { doctor } from "./doctor.js";
import { serviceAction } from "./service.js";
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

function usage(): never {
  process.stderr.write(`AEC commands:
  aec project <add|list|show|update> [...]
  aec agent <add|list|show|update> [...]
  aec graph submit <graph.json>
  aec run [task-id]
  aec daemon
  aec status [project-id]
  aec task <pause|resume|cancel> <task-id>
  aec directive apply <directive.json>
  aec decision <list|show|resolve|record> [...]
  aec service <install|start|stop|restart|status|uninstall>
  aec doctor
  aec mcp
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
  const db = new AecDatabase();
  const engine = new AecEngine(db);
  try {
    if (command === "project" && subcommand === "add") {
      const path = args[0] ?? usage();
      const input = projectInputSchema.parse(readInput(path));
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
      await engine.daemon(controller.signal);
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
    } else {
      usage();
    }
  } finally {
    if (command !== "mcp" && command !== "daemon") db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
