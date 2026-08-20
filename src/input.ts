import { z } from "zod";

const pathSchema = z.string().min(1).max(4_096);
const shortTextSchema = z.string().min(1).max(512);
const longTextSchema = z.string().max(65_536);
const stringListSchema = z.array(z.string().min(1).max(16_384)).max(256);
const boundedJsonRecordSchema = z.record(z.string().max(256), z.unknown()).refine((value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 1024 * 1024;
  } catch {
    return false;
  }
}, "JSON object exceeds 1 MiB or is not serializable");

export const idSchema = z.string().min(1).max(160).regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  "must be a branch-safe identifier using letters, numbers, dot, underscore, or hyphen",
).refine((value) => !value.includes("..") && !value.toLowerCase().endsWith(".lock"), {
  message: "must not contain consecutive dots or end with .lock",
});

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

export const repoGlobSchema = z.string().min(1).max(512).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.includes("\0") && !normalized.startsWith("/") && !normalized.split("/").includes("..") &&
    normalized.split("/").length <= 64 && (normalized.match(/[?*]/g)?.length ?? 0) <= 64;
}, "must be a bounded repository-relative glob without parent traversal");

export const commandSpecSchema = z.object({
  program: pathSchema.refine((value) => !value.includes("\0"), "program contains NUL"),
  args: z.array(z.string().max(65_536)).max(1_024),
  cwd: pathSchema.optional(),
  timeoutSeconds: z.number().positive().max(86_400).optional(),
}).strict();

const jobCommandSpecSchema = commandSpecSchema.extend({
  env: z.record(z.string().max(256), z.string().max(65_536)).refine((value) => Object.keys(value).length <= 256, "too many environment variables").optional(),
}).strict();

export const taskScopeSchema = z.object({
  writeGlobs: z.array(repoGlobSchema).max(256),
  watchGlobs: z.array(repoGlobSchema).max(256).optional(),
  impactGlobs: z.array(repoGlobSchema).max(256).optional(),
  tags: z.array(z.string().min(1).max(160)).max(256),
}).strict().superRefine((value, context) => {
  if (value.watchGlobs === undefined && value.impactGlobs === undefined) {
    context.addIssue({ code: "custom", message: "scope requires watchGlobs" });
  }
}).transform((value) => ({
  writeGlobs: value.writeGlobs,
  watchGlobs: value.watchGlobs ?? value.impactGlobs ?? [],
  tags: value.tags,
}));

const commandListSchema = z.array(commandSpecSchema).max(256);
const environmentComponentSchema = z.object({
  id: idSchema,
  version: z.string().max(512).optional(),
  command: commandSpecSchema.optional(),
  requiredCapabilities: z.array(z.string().min(1).max(160)).max(128).optional(),
}).strict();
const environmentContractSchema = z.object({
  version: z.number().int().min(1),
  components: z.array(environmentComponentSchema).max(256),
}).strict();
const operationalConfigSchema = z.object({
  healthFailureThreshold: z.number().int().min(1).optional(),
  healthRecoveryThreshold: z.number().int().min(1).optional(),
  healthProbeIntervalSeconds: z.number().int().min(1).optional(),
  driftMaxCommits: z.number().int().min(1).optional(),
  driftMaxSeconds: z.number().int().min(1).optional(),
  stabilityObservationSeconds: z.number().int().min(0).optional(),
  networkPolicy: z.object({
    mode: z.literal("brokered"),
    dependencyHosts: z.array(z.string().min(1).max(253).regex(
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
      "must be a lowercase public DNS hostname",
    )).max(128),
  }).strict().optional(),
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
  name: shortTextSchema,
  repoPath: pathSchema,
  targetBranch: gitRefSchema.optional(),
  remoteName: remoteNameSchema.optional(),
  deliveryMode: z.enum(["local", "github"]).optional(),
  intent: longTextSchema.optional(),
  intentVersion: z.number().int().min(1).optional(),
  environmentContract: environmentContractSchema.optional(),
  operationalConfig: operationalConfigSchema.optional(),
  controlPolicy: controlPolicySchema.optional(),
  defaultValidation: commandListSchema.optional(),
  fullValidation: commandListSchema.optional(),
  postMergeSmoke: commandListSchema.optional(),
  requiredChecks: z.array(z.string().min(1).max(512)).max(256).optional(),
  highRiskGlobs: z.array(repoGlobSchema).max(256).optional(),
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
  name: shortTextSchema,
  adapter: z.enum(["codex", "kimi", "deepseek_harness", "command"]),
  runtimeFamily: z.string().min(1).max(160).optional(),
  roles: z.array(z.enum(["executor", "reviewer"])).min(1),
  capabilities: z.array(z.string().min(1).max(160)).max(128).optional(),
  enabled: z.boolean().optional(),
  availability: z.enum(["registered", "healthy", "available", "busy", "degraded", "unavailable", "disabled", "offline"]).optional(),
  maxConcurrency: z.number().int().min(1).max(64).optional(),
  config: boundedJsonRecordSchema.optional(),
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
  title: shortTextSchema,
  goal: z.string().min(1).max(65_536),
  scope: taskScopeSchema,
  dependsOn: z.array(idSchema).max(1_000).optional(),
  constraints: stringListSchema.optional(),
  acceptanceCriteria: stringListSchema.min(1),
  validationCommands: z.array(commandSpecSchema).max(256).optional(),
  requiredCapabilities: z.array(z.string().min(1).max(160)).max(128).optional(),
  proposedRiskClass: z.enum(["docs", "normal", "core"]).optional(),
  environmentRequirements: z.array(idSchema).max(256).optional(),
  revertSafe: z.boolean().optional(),
  requiresFullValidation: z.boolean().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  replacesTaskId: idSchema.optional(),
  decisionIds: z.array(idSchema).max(256).optional(),
}).strict();

export const taskGraphSchema = z.object({
  projectId: idSchema,
  tasks: z.array(taskInputSchema).min(1).max(1_000),
}).strict();

export const directiveSchema = z.object({
  action: z.enum(["pause", "resume", "reprioritize", "cancel"]),
  projectId: idSchema.optional(),
  taskIds: z.array(idSchema).max(1_000).optional(),
  tags: z.array(z.string().min(1).max(160)).max(256).optional(),
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
  title: shortTextSchema,
  body: z.string().min(1).max(65_536),
  options: z.array(z.string().min(1).max(16_384)).max(64).optional(),
  resolution: boundedJsonRecordSchema.optional(),
}).strict();

export const resolutionSchema = boundedJsonRecordSchema;

export const jobInputSchema = z.object({
  command: jobCommandSpecSchema,
  environmentProfile: z.enum(["restricted", "codex", "kimi", "deepseek_harness"]).optional(),
  ephemeralEnvironmentPath: pathSchema.optional(),
  isolation: z.object({
    workspacePath: pathSchema,
    workspaceAccess: z.enum(["full", "metadata"]).optional(),
    mode: z.enum(["workspace-write", "read-only"]),
    networkAccess: z.enum(["none", "provider"]),
    loopbackPorts: z.array(z.number().int().min(1).max(65_535)).max(8).optional(),
    controllerPath: pathSchema,
    runtimeOutputPath: pathSchema,
    evidenceReadPaths: z.array(pathSchema).max(32).optional(),
    credentialReadPaths: z.array(pathSchema).max(256).optional(),
    stateWritePaths: z.array(pathSchema).max(512).optional(),
    gitMetadataPaths: z.array(pathSchema).max(32).optional(),
    homePath: pathSchema,
    tempPath: pathSchema,
  }).strict(),
  stdin: z.string().max(8 * 1024 * 1024).optional(),
  stdoutPath: pathSchema,
  stderrPath: pathSchema,
  resultPath: pathSchema,
}).strict();

export const jobResultSchema = z.object({
  status: z.enum(["completed", "timed_out", "spawn_error", "output_limit", "sandbox_denied"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().optional(),
  inputDigest: z.string().length(64).regex(/^[a-f0-9]+$/),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
}).strict();
