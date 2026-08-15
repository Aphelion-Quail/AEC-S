import { join, resolve } from "node:path";
import type { CommandSpec, Project, Task } from "./types.js";
import { matchesAny, relativeInside } from "./glob.js";

export function shouldRunFullValidation(project: Project, task: Task, changedPaths: string[]): boolean {
  if (task.requiresFullValidation) return true;
  if (task.scope.writeGlobs.length === 0) return true;
  return changedPaths.some((path) => matchesAny(path, project.highRiskGlobs));
}

export function authoritativeCommands(project: Project, task: Task, changedPaths: string[]): CommandSpec[] {
  const commands = [...project.defaultValidation, ...task.validationCommands];
  if (shouldRunFullValidation(project, task, changedPaths)) commands.push(...project.fullValidation);
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveValidationCommand(command: CommandSpec, workspacePath: string): CommandSpec {
  const cwd = resolve(workspacePath, command.cwd ?? ".");
  relativeInside(workspacePath, cwd);
  return {
    ...command,
    cwd,
    timeoutSeconds: command.timeoutSeconds ?? 900,
  };
}

export function validationPaths(runDir: string, index: number, name: string): { stdout: string; stderr: string; result: string; input: string } {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || `command-${index}`;
  const base = join(runDir, `validation-${String(index).padStart(2, "0")}-${safe}`);
  return { stdout: `${base}.stdout.log`, stderr: `${base}.stderr.log`, result: `${base}.job.json`, input: `${base}.input.json` };
}
