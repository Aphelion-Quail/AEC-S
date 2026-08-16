import { z } from "zod";

export const idSchema = z.string().min(1).max(160).regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  "must be a branch-safe identifier using letters, numbers, dot, underscore, or hyphen",
);

const gitRefSchema = z.string().min(1).max(240).refine((value) => {
  const components = value.split("/");
  return !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") &&
    !value.endsWith(".") && !value.includes("//") && !value.includes("..") && !value.includes("@{") &&
    ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) &&
    !/[~^:?*[\\]/.test(value) &&
    components.every((component) => component.length > 0 && !component.endsWith(".lock"));
}, "must be a safe Git branch name");

const remoteNameSchema = z.string().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "must be a safe Git remote name",
);

const repoGlobSchema = z.string().min(1).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.includes("\0") && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}, "must be a repository-relative glob without parent traversal");

export const commandSpecSchema = z.object({
  program: z.string().min(1).refine((value) => !value.includes("\0"), "program contains NUL"),
  args: z.array(z.string()),
  cwd: z.string().optional(),
  timeoutSeconds: z.number().positive().max(86_400).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

export const taskScopeSchema = z.object({
  writeGlobs: z.array(repoGlobSchema),
  impactGlobs: z.array(repoGlobSchema),
  tags: z.array(z.string().min(1)),
}).strict();

const projectBaseSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  targetBranch: gitRefSchema.optional(),
  remoteName: remoteNameSchema.optional(),
  deliveryMode: z.enum(["local", "github"]).optional(),
  intent: z.string().optional(),
  defaultValidation: z.array(commandSpecSchema).optional(),
  fullValidation: z.array(commandSpecSchema).optional(),
  requiredChecks: z.array(z.string().min(1)).optional(),
  highRiskGlobs: z.array(repoGlobSchema).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
}).strict();

export const projectInputSchema = projectBaseSchema.superRefine((value, context) => {
  if (value.deliveryMode === "github" && (value.requiredChecks?.length ?? 0) === 0) {
    context.addIssue({ code: "custom", message: "GitHub delivery requires requiredChecks" });
  }
});

export const projectUpdateSchema = projectBaseSchema.omit({ id: true, name: true, repoPath: true }).partial();

export const agentInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1),
  adapter: z.enum(["codex", "command"]),
  roles: z.array(z.enum(["executor", "reviewer"])).min(1),
  capabilities: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().optional(),
  availability: z.enum(["available", "offline", "degraded"]).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const agentUpdateSchema = agentInputSchema.omit({ id: true, name: true, adapter: true }).partial();

export const taskInputSchema = z.object({
  id: idSchema.optional(),
  projectId: idSchema,
  title: z.string().min(1),
  goal: z.string().min(1),
  scope: taskScopeSchema,
  dependsOn: z.array(idSchema).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  validationCommands: z.array(commandSpecSchema).optional(),
  requiredCapabilities: z.array(z.string().min(1)).optional(),
  requiresFullValidation: z.boolean().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  replacesTaskId: idSchema.optional(),
  decisionIds: z.array(idSchema).optional(),
}).strict();

export const taskGraphSchema = z.object({
  projectId: idSchema,
  tasks: z.array(taskInputSchema).min(1),
}).strict();

export const directiveSchema = z.object({
  action: z.enum(["pause", "resume", "reprioritize", "cancel"]),
  projectId: idSchema.optional(),
  taskIds: z.array(idSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (!value.projectId && (value.taskIds?.length ?? 0) === 0 && (value.tags?.length ?? 0) === 0) {
    context.addIssue({ code: "custom", message: "A directive requires projectId, taskIds, or tags" });
  }
  if (value.action === "reprioritize" && value.priority === undefined) {
    context.addIssue({ code: "custom", message: "reprioritize requires priority" });
  }
});

export const decisionInputSchema = z.object({
  id: idSchema.optional(),
  projectId: idSchema,
  taskId: idSchema.optional(),
  kind: z.enum(["architecture", "product", "tradeoff", "failure_exhausted", "record"]),
  status: z.enum(["pending", "resolved"]).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  resolution: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const resolutionSchema = z.record(z.string(), z.unknown());

export const jobInputSchema = z.object({
  command: commandSpecSchema,
  stdin: z.string().optional(),
  stdoutPath: z.string().min(1),
  stderrPath: z.string().min(1),
  resultPath: z.string().min(1),
}).strict();
