import { join } from "node:path";
import type { AecDatabase } from "./db.js";
import type { Project, Run, Task, Workspace } from "./types.js";
import { writeJsonAtomic } from "./files.js";
import { redactJson } from "./redaction.js";

export type ContextEnvelope = {
  project: { id: string; name: string; intent: string; targetBranch: string };
  task: Task;
  decisions: unknown[];
  dependencies: Array<{ taskId: string; status: string; summary?: string; mergeSha?: string }>;
  workspace: { path: string; branch: string; baseSha: string };
  validation: Run["validation"];
  current: { runId: string; phase: string; attempt: number; repairCount: number; feedback?: unknown };
};

export function buildContextEnvelope(
  db: AecDatabase,
  project: Project,
  task: Task,
  run: Run,
  workspace: Workspace,
  feedback?: unknown,
  options: { outputDir?: string; reviewer?: boolean } = {},
): { envelope: ContextEnvelope; path: string } {
  const explicit = new Set(task.decisionIds);
  const decisions = db
    .listDecisions(project.id, "resolved")
    .filter((decision) => !decision.taskId || decision.taskId === task.id || explicit.has(decision.id));
  const dependencies = task.dependsOn.map((taskId) => {
    const dependency = db.getTask(taskId);
    return {
      taskId,
      status: dependency?.status ?? "missing",
      ...(dependency?.terminalSummary ? { summary: dependency.terminalSummary } : {}),
      ...(dependency?.mergeSha ? { mergeSha: dependency.mergeSha } : {}),
    };
  });
  const envelope: ContextEnvelope = {
    project: { id: project.id, name: project.name, intent: project.intent, targetBranch: project.targetBranch },
    task: redactJson(task),
    decisions: redactJson(decisions),
    dependencies,
    workspace: { path: workspace.path, branch: workspace.branch, baseSha: workspace.baseSha },
    validation: redactJson(options.reviewer
      ? run.validation.map((validation) => ({ ...validation, stdoutPath: "[AEC-managed]", stderrPath: "[AEC-managed]" }))
      : run.validation),
    current: {
      runId: run.id,
      phase: run.phase,
      attempt: run.attempt,
      repairCount: run.repairCount,
      ...(feedback !== undefined ? { feedback: redactJson(feedback) } : {}),
    },
  };
  const path = join(options.outputDir ?? run.logDir, `context-${run.phase}-${run.attempt}-${run.repairCount}.json`);
  writeJsonAtomic(path, envelope);
  return { envelope, path };
}

export function executionPrompt(contextPath: string): string {
  return [
    "You are an AEC worker executing one immutable engineering task.",
    `Read the task context envelope at ${contextPath}.`,
    "Implement the task in the current workspace.",
    "You may run exploratory tests and debugging commands.",
    "Do not commit, push, merge, switch branches, or modify AEC state.",
    "Do not intentionally modify files outside task.scope.writeGlobs.",
    "Return only the structured result required by the output schema.",
  ].join("\n");
}

export function repairPrompt(contextPath: string): string {
  return [
    "Continue the same AEC task and repair the reported authoritative validation or review failures.",
    `Read the updated context envelope at ${contextPath}.`,
    "Do not commit, push, merge, switch branches, or modify AEC state.",
    "Return only the structured result required by the output schema.",
  ].join("\n");
}

export function reviewPrompt(contextPath: string, diffPath: string): string {
  return [
    "You are an independent AEC reviewer.",
    `Read the task context envelope at ${contextPath}.`,
    `Review only the task diff at ${diffPath} against the goal, constraints, decisions, and validation evidence.`,
    "Do not modify files. Do not infer approval from the executor's claims.",
    "Return only the structured review result required by the output schema.",
  ].join("\n");
}
