export type JsonObject = Record<string, unknown>;

export type CommandSpec = {
  program: string;
  args: string[];
  cwd?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
};

export type TaskScope = {
  writeGlobs: string[];
  impactGlobs: string[];
  tags: string[];
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
  defaultValidation?: CommandSpec[];
  fullValidation?: CommandSpec[];
  requiredChecks?: string[];
  highRiskGlobs?: string[];
  maxConcurrency?: number;
};

export type Project = Required<Omit<ProjectInput, "id">> & {
  id: string;
  createdAt: string;
};

export type TaskStatus =
  | "queued"
  | "ready"
  | "running"
  | "paused"
  | "operational_blocked"
  | "awaiting_human"
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
  requiresFullValidation?: boolean;
  priority?: number;
  replacesTaskId?: string;
  decisionIds?: string[];
};

export type Task = Required<Omit<TaskInput, "id" | "replacesTaskId">> & {
  id: string;
  replacesTaskId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  terminalSummary?: string;
  mergeSha?: string;
};

export type AgentRole = "executor" | "reviewer";
export type AgentAvailability = "available" | "offline" | "degraded";

export type AgentInput = {
  id?: string;
  name: string;
  adapter: "codex" | "command";
  roles: AgentRole[];
  capabilities?: string[];
  enabled?: boolean;
  availability?: AgentAvailability;
  maxConcurrency?: number;
  config?: JsonObject;
};

export type Agent = Required<Omit<AgentInput, "id">> & {
  id: string;
  currentLoad: number;
};

export type RunPhase =
  | "prepare"
  | "execute"
  | "validate"
  | "review"
  | "repair"
  | "publish"
  | "remote_checks"
  | "merge"
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
  file?: string;
  line?: number;
  requiredChange?: string;
};

export type ReviewResult = {
  verdict: "pass" | "fail";
  summary: string;
  findings: ReviewFinding[];
  reviewerAgentId?: string;
};

export type WorkerResult = {
  status: "complete" | "blocked";
  summary: string;
  notes: string[];
};

export type JobState = {
  id: string;
  inputPath: string;
  resultPath: string;
  pid?: number;
  startedAt: string;
  label?: string;
  structuredOutputPath?: string;
  agentId?: string;
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
  kind: "architecture" | "product" | "tradeoff" | "failure_exhausted" | "record";
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

export type JobInput = {
  command: CommandSpec;
  stdin?: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
};

export type JobResult = {
  status: "completed" | "timed_out" | "spawn_error";
  exitCode: number | null;
  signal: string | null;
  error?: string;
  startedAt: string;
  finishedAt: string;
};
