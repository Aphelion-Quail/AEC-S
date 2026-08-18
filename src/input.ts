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
    components.every((component) => component.length > 0 && component !== "." && !component.endsWith(".lock"));
}, "must be a safe Git branch name");

const remoteNameSchema = z.string().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "must be a safe Git remote name",
);

export const repoGlobSchema = z.string().min(1).refine((value) => {
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
  watchGlobs: z.array(repoGlobSchema).optional(),
  impactGlobs: z.array(repoGlobSchema).optional(),
  tags: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  if (value.watchGlobs === undefined && value.impactGlobs === undefined) {
    context.addIssue({ code: "custom", message: "scope requires watchGlobs" });
  }
}).transform((value) => ({
  writeGlobs: value.writeGlobs,
  watchGlobs: value.watchGlobs ?? value.impactGlobs ?? [],
  tags: value.tags,
}));

const commandListSchema = z.array(commandSpecSchema);
const environmentComponentSchema = z.object({
  id: idSchema,
  version: z.string().optional(),
  command: commandSpecSchema.optional(),
  requiredCapabilities: z.array(z.string().min(1)).optional(),
}).strict();
const environmentContractSchema = z.object({
  version: z.number().int().min(1),
  components: z.array(environmentComponentSchema),
}).strict();
const operationalConfigSchema = z.object({
  healthFailureThreshold: z.number().int().min(1).optional(),
  healthRecoveryThreshold: z.number().int().min(1).optional(),
  healthProbeIntervalSeconds: z.number().int().min(1).optional(),
  driftMaxCommits: z.number().int().min(1).optional(),
  driftMaxSeconds: z.number().int().min(1).optional(),
  stabilityObservationSeconds: z.number().int().min(0).optional(),
}).strict();
const controlPolicySchema = z.object({
  version: z.number().int().min(1).optional(),
  scopeCalibration: z.enum(["observe", "enforce"]).optional(),
  temporaryRiskElevation: z.enum(["observe", "enforce"]).optional(),
  progressiveDagParking: z.enum(["observe", "enforce"]).optional(),
  autoRevert: z.enum(["observe", "enforce"]).optional(),
  circuitBreaker: z.enum(["observe", "enforce"]).optional(),
  strictReviewMinRuntimeFamilies: z.number().int().min(1).max(8).optional(),
}).strict();

const projectBaseSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  targetBranch: gitRefSchema.optional(),
  remoteName: remoteNameSchema.optional(),
  deliveryMode: z.enum(["local", "github"]).optional(),
  intent: z.string().optional(),
  intentVersion: z.number().int().min(1).optional(),
  environmentContract: environmentContractSchema.optional(),
  operationalConfig: operationalConfigSchema.optional(),
  controlPolicy: controlPolicySchema.optional(),
  defaultValidation: commandListSchema.optional(),
  fullValidation: commandListSchema.optional(),
  postMergeSmoke: commandListSchema.optional(),
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
  adapter: z.enum(["codex", "kimi", "deepseek_harness", "command"]),
  runtimeFamily: z.string().min(1).optional(),
  roles: z.array(z.enum(["executor", "reviewer"])).min(1),
  capabilities: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().optional(),
  availability: z.enum(["registered", "healthy", "available", "busy", "degraded", "unavailable", "disabled", "offline"]).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  runtimeCapabilities: z.object({
    resume: z.boolean().optional(),
    cancel: z.boolean().optional(),
    stream: z.boolean().optional(),
    reviewMode: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
  }).strict().optional(),
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
  proposedRiskClass: z.enum(["docs", "normal", "core"]).optional(),
  environmentRequirements: z.array(idSchema).optional(),
  revertSafe: z.boolean().optional(),
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
  kind: z.enum(["architecture", "product", "tradeoff", "failure_exhausted", "policy", "direction", "record"]),
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
