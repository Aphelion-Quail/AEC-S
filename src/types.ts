export type JsonObject = Record<string, unknown>;

export type ChildEnvironmentProfile = "restricted" | "codex" | "kimi" | "deepseek_harness";

export type ProcessIsolation = {
  workspacePath: string;
  workspaceAccess?: "full" | "metadata";
  mode: "workspace-write" | "read-only";
  networkAccess: "none" | "provider";
  /** Controller-owned evidence is readable but never writable by a Runtime. */
  controllerPath: string;
  /** The sole controller-adjacent directory a Runtime may write. */
  runtimeOutputPath: string;
  evidenceReadPaths?: string[];
  credentialReadPaths?: string[];
  stateWritePaths?: string[];
  gitMetadataPaths?: string[];
  homePath: string;
  tempPath: string;
};

export type CommandSpec = {
  program: string;
  args: string[];
  cwd?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
};

export type TaskScope = {
  writeGlobs: string[];
  watchGlobs?: string[];
  tags: string[];
  /** Pre-1.0 input compatibility only. New output never emits this field. */
  impactGlobs?: string[];
};

export type RiskClass = "docs" | "normal" | "core";
export type ReviewMode = "none" | "standard" | "strict";
export type AdaptiveMode = "observe" | "enforce";

export type EnvironmentComponent = {
  id: string;
  version?: string;
  command?: CommandSpec;
  requiredCapabilities?: string[];
};

export type EnvironmentContract = {
  version: number;
  components: EnvironmentComponent[];
};

export type OperationalConfiguration = {
  healthFailureThreshold: number;
  healthRecoveryThreshold: number;
  healthProbeIntervalSeconds: number;
  driftMaxCommits?: number;
  driftMaxSeconds?: number;
  stabilityObservationSeconds: number;
};

export type ControlPolicy = {
  version: number;
  scopeCalibration: AdaptiveMode;
  temporaryRiskElevation: AdaptiveMode;
  progressiveDagParking: AdaptiveMode;
  autoRevert: AdaptiveMode;
  circuitBreaker: AdaptiveMode;
  strictReviewMinRuntimeFamilies: number;
};

export type DeliveryMode = "local" | "github";

export type ProjectInput = {
  id?: string;
  name: string;
  repoPath: string;
  targetBranch?: string;
  remoteName?: string;
  deliveryMode?: DeliveryMode;
  intent?: string;
  intentVersion?: number;
  environmentContract?: EnvironmentContract;
  operationalConfig?: Partial<OperationalConfiguration>;
  controlPolicy?: Partial<ControlPolicy>;
  defaultValidation?: CommandSpec[];
  fullValidation?: CommandSpec[];
  postMergeSmoke?: CommandSpec[];
  requiredChecks?: string[];
  highRiskGlobs?: string[];
  maxConcurrency?: number;
};

export type Project = Required<Omit<ProjectInput,
  "id" | "intentVersion" | "environmentContract" | "operationalConfig" | "controlPolicy" | "postMergeSmoke"
>> & {
  id: string;
  createdAt: string;
  intentVersion?: number;
  environmentContract?: EnvironmentContract;
  operationalConfig?: OperationalConfiguration;
  controlPolicy?: ControlPolicy;
  postMergeSmoke?: CommandSpec[];
};

export type ProjectUpdate = Partial<Omit<ProjectInput, "id" | "repoPath" | "name">>;

export type TaskStatus =
  | "queued"
  | "ready"
  | "running"
  | "paused"
  | "operational_blocked"
  | "awaiting_human"
  | "parked"
  | "observing"
  | "circuit_broken"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskInput = {
  id?: string;
  projectId: string;
  title: string;
  goal: string;
  scope: TaskScope;
  dependsOn?: string[];
  constraints?: string[];
  acceptanceCriteria: string[];
  validationCommands?: CommandSpec[];
  requiredCapabilities?: string[];
  proposedRiskClass?: RiskClass;
  environmentRequirements?: string[];
  revertSafe?: boolean;
  requiresFullValidation?: boolean;
  priority?: number;
  replacesTaskId?: string;
  decisionIds?: string[];
};

export type Task = Required<Omit<TaskInput,
  "id" | "replacesTaskId" | "proposedRiskClass" | "environmentRequirements" | "revertSafe"
>> & {
  id: string;
  replacesTaskId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  terminalSummary?: string;
  mergeSha?: string;
  currentRevisionId?: string;
  proposedRiskClass?: RiskClass;
  environmentRequirements?: string[];
  revertSafe?: boolean;
};

export type TaskRevision = {
  id: string;
  taskId: string;
  revision: number;
  scope: TaskScope;
  proposedRiskClass: RiskClass;
  effectiveRiskClass: RiskClass;
  gateProfile: {
    review: ReviewMode;
    validation: "minimal" | "applicable";
  };
  environmentRequirements: string[];
  contextFingerprint: string;
  reason: "initial" | "scope_expansion" | "calibration";
  createdAt: string;
};

export type ScopeExpansionProposal = {
  addWriteGlobs: string[];
  addWatchGlobs: string[];
  evidence: string;
};

export type AgentRole = "executor" | "reviewer";
export type AgentAdapterKind = "codex" | "kimi" | "deepseek_harness" | "command";
export type AgentAvailability =
  | "registered"
  | "healthy"
  | "available"
  | "busy"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "offline";

export type RuntimeCapabilities = {
  resume: boolean;
  cancel: boolean;
  stream: boolean;
  reviewMode: boolean;
  structuredOutput: boolean;
};

export type AgentInput = {
  id?: string;
  name: string;
  adapter: AgentAdapterKind;
  runtimeFamily?: string;
  roles: AgentRole[];
  capabilities?: string[];
  enabled?: boolean;
  availability?: AgentAvailability;
  maxConcurrency?: number;
  config?: JsonObject;
  runtimeCapabilities?: Partial<RuntimeCapabilities>;
};

export type Agent = Required<Omit<AgentInput, "id" | "runtimeFamily" | "runtimeCapabilities">> & {
  id: string;
  currentLoad: number;
  runtimeFamily?: string;
  runtimeCapabilities?: RuntimeCapabilities;
  healthSuccesses?: number;
  healthFailures?: number;
  lastAssignedAt?: string;
  runtimeVersion?: string;
};

export type AgentUpdate = Partial<Omit<AgentInput, "id" | "name" | "adapter">>;

export type RunPhase =
  | "prepare"
  | "execute"
  | "validate"
  | "review"
  | "repair"
  | "publish"
  | "remote_checks"
  | "merge"
  | "post_merge_smoke"
  | "stability_observation"
  | "revert"
  | "cleanup"
  | "done";

export type RunStatus = "active" | "completed" | "failed" | "interrupted";

export type EffectStatus = "pending" | "started" | "completed" | "uncertain";
export type EffectState = {
  operationId: string;
  status: EffectStatus;
  externalRef?: string;
};

export type RunEffects = {
  commit?: EffectState;
  push?: EffectState;
  pullRequest?: EffectState;
  merge?: EffectState;
  postMergeSmoke?: EffectState;
  revert?: EffectState;
};

export type ValidationResult = {
  name: string;
  command: CommandSpec;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  startedAt: string;
  finishedAt: string;
};

export type ReviewFinding = {
  severity: "blocking" | "warning";
  summary: string;
  file?: string | null;
  line?: number | null;
  requiredChange?: string | null;
  evidence?: string | null;
  category?: string | null;
};

export type ReviewResult = {
  /** Compatibility signal only; merge authority is derived from verified Findings. */
  verdict?: "pass" | "fail";
  summary: string;
  findings: ReviewFinding[];
  reviewerAgentId?: string;
  /** Controller-generated digest of the exact diff accepted by the Gate. */
  evidenceDiffDigest?: string;
  completed: boolean;
};

export type WorkerResult = {
  status: "complete" | "blocked";
  summary: string;
  notes: string[];
  blocker?: {
    kind: "technical" | "architecture" | "product" | "tradeoff";
    question: string;
  } | null;
  scopeExpansion?: ScopeExpansionProposal | null;
};

export type JobState = {
  id: string;
  inputPath: string;
  inputDigest: string;
  resultPath: string;
  pid?: number;
  startedAt: string;
  label?: string;
  structuredOutputPath?: string;
  agentId?: string;
  authorityHeadSha?: string;
};

export type Run = {
  id: string;
  taskId: string;
  agentId: string;
  workspaceId: string;
  phase: RunPhase;
  status: RunStatus;
  attempt: number;
  repairCount: number;
  rotationCount: number;
  baseSha: string;
  codexSessionId?: string;
  runtimeSessionId?: string;
  runtimeVersion?: string;
  taskRevisionId?: string;
  contextFingerprint?: string;
  metrics?: {
    implementationMs: number;
    controlMs: number;
    validationMs: number;
    reviewMs: number;
    waitMs: number;
    validationRuns: number;
    repairRuns: number;
    runtimeSwitches: number;
    tokenUsage?: { input?: number; output?: number; total?: number };
  };
  workerResult?: WorkerResult;
  workerResultPath?: string;
  validation: ValidationResult[];
  review?: ReviewResult;
  effects: RunEffects;
  job?: JobState;
  logDir: string;
  diffPath?: string;
  error?: JsonObject;
  startedAt: string;
  updatedAt: string;
  leaseUntil?: string;
  leaseOwner?: string;
};

export type WorkspaceStatus = "creating" | "active" | "preserved" | "cleaned";
export type Workspace = {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  path: string;
  branch: string;
  baseSha: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
};

export type DecisionStatus = "pending" | "resolved";
export type DecisionInput = {
  id?: string;
  projectId: string;
  taskId?: string;
  kind: "architecture" | "product" | "tradeoff" | "failure_exhausted" | "policy" | "direction" | "record";
  status?: DecisionStatus;
  title: string;
  body: string;
  options?: string[];
  resolution?: JsonObject;
};

export type Decision = Required<Omit<DecisionInput, "id" | "taskId" | "resolution">> & {
  id: string;
  taskId?: string;
  resolution?: JsonObject;
  createdAt: string;
  resolvedAt?: string;
};

export type EventRecord = {
  id: number;
  projectId?: string;
  taskId?: string;
  runId?: string;
  type: string;
  payload: JsonObject;
  createdAt: string;
};

export type FindingStatus = "proposed" | "structurally_valid" | "verified" | "dismissed" | "resolved";
export type Finding = {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  taskRevisionId: string;
  signature: string;
  status: FindingStatus;
  severity: "blocking" | "warning";
  summary: string;
  rule?: string;
  file?: string;
  line?: number;
  evidence?: string;
  resolutionEvidence?: string;
  reviewerAgentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type OutboxStatus = "pending" | "delivering" | "delivered" | "acknowledged";
export type OutboxMessage = {
  id: string;
  projectId: string;
  decisionId?: string;
  dedupeKey: string;
  status: OutboxStatus;
  channel: "mcp" | "system";
  title: string;
  body: string;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
};

export type JobInput = {
  command: CommandSpec;
  environmentProfile?: ChildEnvironmentProfile;
  isolation: ProcessIsolation;
  stdin?: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
};

export type JobResult = {
  status: "completed" | "timed_out" | "spawn_error" | "output_limit" | "sandbox_denied";
  exitCode: number | null;
  signal: string | null;
  error?: string;
  inputDigest: string;
  startedAt: string;
  finishedAt: string;
};
