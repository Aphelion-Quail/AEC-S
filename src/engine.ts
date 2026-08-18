import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AecSDatabase } from "./db.js";
import type {
  Agent,
  AgentRole,
  ChildEnvironmentProfile,
  CommandSpec,
  Decision,
  EffectState,
  JobInput,
  JobResult,
  JsonObject,
  Project,
  ReviewResult,
  Run,
  RunEffects,
  Task,
  TaskInput,
  ValidationResult,
  WorkerResult,
  Workspace,
} from "./types.js";
import { newId, nowIso } from "./ids.js";
import { adapterFor, type AgentAdapter, type AgentInvocation } from "./adapters/agent.js";
import type { RuntimeProbeResult } from "./runtime-probe.js";
import { buildContextEnvelope, executionPrompt, repairPrompt, reviewPrompt } from "./context.js";
import {
  branchHead,
  changedPaths,
  changedPathsBetween,
  commitCountBetween,
  changesAffectTask,
  cleanupWorktree,
  commitTask,
  continueRebase,
  createWorktree,
  fetchRemote,
  fetchRemoteUnlocked,
  isAncestor,
  localMerge,
  mergeBase,
  outOfScopePaths,
  projectBaseRef,
  rebaseInProgress,
  rebaseOntoTarget,
  restoreWorkspaceHead,
  revertMergedTask,
  verifyMergedRevision,
  workspaceHasChanges,
  writeDiff,
  withProjectGitLock,
} from "./git.js";
import { matchesAny, tasksConflict } from "./glob.js";
import { assertFileSize, parseStructuredOutput, readJson, readTextBounded } from "./files.js";
import { processAlive, startSupervisedJob, waitForJob } from "./job.js";
import { authoritativeCommands, resolveValidationCommand, validationPaths } from "./validation.js";
import { writeSchemas } from "./schemas.js";
import { taskInputSchema } from "./input.js";
import {
  createOrGetPullRequest,
  deleteRemoteTaskBranch,
  inspectRequiredChecks,
  mergePullRequest,
  pushTaskBranch,
  reconcileMergedPullRequest,
  remoteTaskBranchHead,
} from "./github.js";
import { redactJson, redactText } from "./redaction.js";
import { fingerprint } from "./fingerprint.js";
import { execCommand } from "./exec.js";
import { AEC_ERROR, AecError, isAecError } from "./errors.js";
import { classifyPhaseError } from "./engine-errors.js";
import {
  bearsRevisionEvidence,
  isControlPhase,
  occupiesRuntimeCapacity,
  selectDeterministicAgent,
} from "./engine-policy.js";

type EngineOptions = {
  globalConcurrency?: number;
  leaseHeartbeatMs?: number;
  operationalRetryBaseMs?: number;
  maxOperationalRetries?: number;
  agentHealthcheckIntervalMs?: number;
  adapterFactory?: (agent: Agent) => AgentAdapter;
};

type JobExecution = {
  result: JobResult;
  stdoutPath: string;
  stderrPath: string;
  structuredOutputPath?: string;
};

export class AecSEngine {
  private readonly globalConcurrency: number;
  private readonly leaseHeartbeatMs: number;
  private readonly operationalRetryBaseMs: number;
  private readonly maxOperationalRetries: number;
  private readonly agentHealthcheckIntervalMs?: number;
  private readonly adapterFactory: (agent: Agent) => AgentAdapter;
  private readonly inProcess = new Set<string>();
  private readonly leaseOwner = `${process.pid}:${newId("lease")}`;
  private schedulerCycles = 0;
  private lastAgentHealthcheckAt = 0;

  constructor(readonly db: AecSDatabase, options: EngineOptions = {}) {
    this.globalConcurrency = options.globalConcurrency ?? 3;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 10_000;
    this.operationalRetryBaseMs = options.operationalRetryBaseMs ?? 5_000;
    this.maxOperationalRetries = options.maxOperationalRetries ?? 5;
    this.agentHealthcheckIntervalMs = options.agentHealthcheckIntervalMs;
    this.adapterFactory = options.adapterFactory ?? adapterFor;
  }

  submitGraph(projectId: string, inputs: TaskInput[]): Task[] {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (inputs.length === 0) throw new Error("Task graph cannot be empty");
    const parsedInputs = inputs.map((input) => taskInputSchema.parse(input) as TaskInput);
    const normalized = parsedInputs.map((input) => ({ ...input, id: input.id ?? newId("task"), projectId }));
    const graphIds = new Set(normalized.map((input) => input.id!));
    if (graphIds.size !== normalized.length) throw new Error("Task graph contains duplicate IDs");
    for (const input of normalized) this.validateTaskInput(input, project);
    for (const input of normalized) {
      if (input.replacesTaskId) {
        if (input.replacesTaskId === input.id) throw new Error(`Task ${input.id} cannot replace itself`);
        const replaced = this.db.getTask(input.replacesTaskId);
        if (!replaced) throw new Error(`Replacement target does not exist: ${input.replacesTaskId}`);
        if (replaced.projectId !== projectId) throw new Error(`Replacement target belongs to another Project: ${input.replacesTaskId}`);
      }
      for (const decisionId of input.decisionIds ?? []) {
        const decision = this.db.getDecision(decisionId);
        if (!decision || decision.projectId !== projectId || decision.status !== "resolved") {
          throw new Error(`Task ${input.id} references an unavailable Decision: ${decisionId}`);
        }
      }
      for (const dependency of input.dependsOn ?? []) {
        const existing = this.db.getTask(dependency);
        if (!graphIds.has(dependency) && !existing) throw new Error(`Unknown dependency ${dependency} for task ${input.id}`);
        if (existing && existing.projectId !== projectId) throw new Error(`Cross-project dependency is not supported: ${dependency}`);
      }
    }
    this.assertAcyclic(normalized);
    return this.db.transaction(() => {
      const tasks = normalized.map((input) => this.db.createTask(input));
      for (const task of tasks) {
        if (task.replacesTaskId) {
          const replaced = this.db.getTask(task.replacesTaskId);
          if (replaced && !["succeeded", "failed", "cancelled"].includes(replaced.status)) {
            this.db.updateTaskStatus(replaced.id, "cancelled", { summary: `Replaced by ${task.id}` });
          }
        }
      }
      const deferred = tasks.filter((task) => task.status === "queued").length;
      if (deferred > 0) {
        this.db.appendEvent({
          projectId,
          type: "policy.progressive_dag_parking",
          payload: { mode: project.controlPolicy?.progressiveDagParking ?? "observe", deferred, frontier: tasks.length - deferred },
        });
      }
      return tasks;
    });
  }

  private validateTaskInput(input: TaskInput, project?: Project): void {
    if (!input.title.trim()) throw new Error("Task title is required");
    if (!input.goal.trim()) throw new Error("Task goal is required");
    if (input.acceptanceCriteria.length === 0) throw new Error(`Task ${input.id ?? input.title} requires acceptance criteria`);
    if (input.priority !== undefined && (input.priority < -100 || input.priority > 100)) {
      throw new Error(`Task priority must be between -100 and 100: ${input.id ?? input.title}`);
    }
    for (const command of input.validationCommands ?? []) this.validateCommand(command);
    if (project) {
      const environmentIds = new Set((project.environmentContract?.components ?? []).map((component) => component.id));
      for (const requirement of input.environmentRequirements ?? []) {
        if (!environmentIds.has(requirement)) throw new Error(`Task ${input.id ?? input.title} requires undeclared Environment component: ${requirement}`);
      }
    }
  }

  private validateCommand(command: CommandSpec): void {
    if (!command.program || command.program.includes("\0")) throw new Error("Validation command program is invalid");
    if (!Array.isArray(command.args)) throw new Error("Validation command args must be an array");
  }

  private assertAcyclic(tasks: TaskInput[]): void {
    const graph = new Map(tasks.map((task) => [task.id!, (task.dependsOn ?? []).filter((id) => tasks.some((item) => item.id === id))]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Task graph contains a cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of graph.keys()) visit(id);
  }

  promoteTasks(): void {
    for (const task of this.db.listTasksByStatus("queued")) {
      const dependencies = task.dependsOn.map((id) => this.db.getTask(id));
      if (dependencies.some((dependency) => !dependency)) {
        this.db.updateTaskStatus(task.id, "operational_blocked", { summary: "A dependency is missing" });
      } else if (dependencies.some((dependency) => ["failed", "cancelled"].includes(dependency!.status))) {
        this.db.updateTaskStatus(task.id, "operational_blocked", { summary: "A dependency ended without success" });
      } else if (dependencies.every((dependency) => dependency!.status === "succeeded")) {
        this.db.updateTaskStatus(task.id, "ready");
      }
    }
  }

  async runOnce(): Promise<number> {
    this.schedulerCycles += 1;
    if (this.schedulerCycles % 100 === 0) this.db.pruneEvents();
    this.promoteOperationalRetries();
    this.promoteCompletedObservations();
    this.promoteCompletedRepairs();
    this.promoteTasks();
    this.recalculateAgentLoad();
    const allActiveRuns = this.db.listActiveRuns();
    const cleanupRuns = allActiveRuns.filter((run) => run.phase === "cleanup");
    const capacityRuns = allActiveRuns.filter((run) =>
      occupiesRuntimeCapacity(run.phase) && this.db.getTask(run.taskId)?.status !== "paused");
    const waitingRuns = allActiveRuns.filter((run) => run.phase !== "cleanup" && !occupiesRuntimeCapacity(run.phase));
    const activeRuns = [...cleanupRuns, ...capacityRuns, ...waitingRuns].filter((run) => {
      if (!this.canClaimRun(run)) return false;
      if (run.status !== "interrupted" || run.phase !== "cleanup") return true;
      const retry = run.error?.operationalRetry;
      if (!retry || typeof retry !== "object" || Array.isArray(retry)) return true;
      return Date.parse(String((retry as JsonObject).nextAttemptAt ?? "")) <= Date.now();
    });
    const work: Array<Promise<void>> = [];
    for (const run of activeRuns) {
      if (this.inProcess.has(run.taskId)) continue;
      work.push(this.runTaskSafely(run.taskId));
    }
    const activeTasks = allActiveRuns
      .map((run) => this.db.getTask(run.taskId))
      .filter((task): task is Task => Boolean(task));
    const selected = [...activeTasks];
    const conflictReservationCandidates = [
      ...activeTasks,
      ...this.db.listTasksByStatus("operational_blocked").filter((task) => {
        const latest = this.db.getLatestRunForTask(task.id);
        return latest?.status === "interrupted" && latest.phase === "remote_checks";
      }),
    ];
    const conflictReservations = [...new Map(conflictReservationCandidates.map((task) => [task.id, task])).values()];
    const reservedLoads = new Map(this.db.listAgents().map((agent) => [agent.id, agent.currentLoad]));
    let slots = Math.max(0, this.globalConcurrency - capacityRuns.length);
    for (const task of this.db.listRunnableTasks()) {
      if (slots === 0) break;
      if (task.status !== "ready" || this.inProcess.has(task.id) || allActiveRuns.some((run) => run.taskId === task.id)) continue;
      const project = this.db.getProject(task.projectId);
      if (!project) continue;
      const projectActive = selected.filter((item) => item.projectId === project.id).length;
      if (projectActive >= project.maxConcurrency) continue;
      if (conflictReservations.some((other) => other.projectId === task.projectId && tasksConflict(task.scope, other.scope))) continue;
      const reservedAgent = this.selectAgent("executor", task.requiredCapabilities, new Set(), reservedLoads);
      if (!reservedAgent) continue;
      reservedLoads.set(reservedAgent.id, (reservedLoads.get(reservedAgent.id) ?? 0) + 1);
      selected.push(task);
      conflictReservations.push(task);
      slots -= 1;
      work.push(this.runTaskSafely(task.id, reservedAgent.id));
    }
    // One operational failure must not terminate the daemon or cause a CLI
    // caller to close the database while sibling Runs are still writing.
    await Promise.allSettled(work);
    return work.length;
  }

  async runUntilIdle(maxCycles = Number.POSITIVE_INFINITY): Promise<void> {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      const count = await this.runOnce();
      if (count === 0) return;
    }
    throw new Error(`AEC-S did not become idle after ${maxCycles} scheduler cycles`);
  }

  private async runTaskSafely(taskId: string, preferredAgentId?: string): Promise<void> {
    try {
      await this.runTask(taskId, preferredAgentId);
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      if (isAecError(error, AEC_ERROR.runLeaseLost)) return;
      const task = this.db.getTask(taskId);
      if (task && ["ready", "running"].includes(task.status)) {
        this.db.updateTaskStatus(taskId, "operational_blocked", { summary: message });
        this.db.appendEvent({
          projectId: task.projectId,
          taskId,
          type: "task.scheduler_error",
          payload: { message },
        });
      }
    }
  }

  async daemon(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.refreshAgentAvailabilityIfDue();
      const count = await this.runOnce();
      if (count === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async refreshAgentAvailability(): Promise<Map<string, RuntimeProbeResult>> {
    const results = new Map<string, RuntimeProbeResult>();
    const probeCache = new Map<string, Promise<RuntimeProbeResult>>();
    const agents = this.db.listAgents().filter((agent) => agent.enabled && agent.availability !== "offline");
    const probes = agents.map((agent) => {
      const cacheKey = JSON.stringify({ adapter: agent.adapter, config: agent.config });
      let pending = probeCache.get(cacheKey);
      if (!pending) {
        pending = this.adapterFactory(agent).probe();
        probeCache.set(cacheKey, pending);
      }
      return pending.then(
        (probe) => ({ agent, probe }),
        (error: unknown) => ({
          agent,
          probe: { ok: false, detail: redactText(error instanceof Error ? error.message : String(error)) } as RuntimeProbeResult,
        }),
      );
    });
    for (const { agent, probe } of await Promise.all(probes)) {
      results.set(agent.id, probe);
      this.db.recordAgentHealth(agent.id, probe.ok, probe.version);
    }
    this.lastAgentHealthcheckAt = Date.now();
    return results;
  }

  private async refreshAgentAvailabilityIfDue(): Promise<void> {
    const configuredInterval = this.db.listProjects().length > 0
      ? Math.min(...this.db.listProjects().map((project) => project.operationalConfig?.healthProbeIntervalSeconds ?? 60)) * 1_000
      : 60_000;
    if (Date.now() - this.lastAgentHealthcheckAt < (this.agentHealthcheckIntervalMs ?? configuredInterval)) return;
    await this.refreshAgentAvailability();
  }

  private promoteOperationalRetries(): void {
    for (const task of this.db.listTasksByStatus("operational_blocked")) {
      const run = this.db.getLatestRunForTask(task.id);
      const retry = run?.error?.operationalRetry;
      const externalWait = run?.error?.externalWait;
      if (run?.status === "interrupted" && externalWait && typeof externalWait === "object" && !Array.isArray(externalWait)) {
        const nextAttemptAt = String((externalWait as JsonObject).nextAttemptAt ?? "");
        if (nextAttemptAt && Date.parse(nextAttemptAt) <= Date.now()) {
          this.db.updateTaskStatus(task.id, "ready", { summary: "External wait is ready for reconciliation" });
          this.db.appendEvent({ projectId: task.projectId, taskId: task.id, runId: run.id, type: "run.external_wait_ready", payload: { nextAttemptAt } });
        }
        continue;
      }
      if (!run || run.status !== "interrupted" || !retry || typeof retry !== "object" || Array.isArray(retry)) continue;
      const nextAttemptAt = String((retry as JsonObject).nextAttemptAt ?? "");
      if (!nextAttemptAt || Date.parse(nextAttemptAt) > Date.now()) continue;
      this.db.updateTaskStatus(task.id, "ready", { summary: "Automatic operational retry is ready" });
      this.db.appendEvent({
        projectId: task.projectId,
        taskId: task.id,
        runId: run.id,
        type: "run.retry_ready",
        payload: { nextAttemptAt },
      });
    }
  }

  private promoteCompletedObservations(): void {
    for (const task of this.db.listTasksByStatus("observing")) {
      const run = this.db.getLatestRunForTask(task.id);
      const observation = run?.error?.stabilityObservation;
      if (!run || run.status !== "interrupted" || run.phase !== "stability_observation" ||
          !observation || typeof observation !== "object" || Array.isArray(observation)) continue;
      const completesAt = String((observation as JsonObject).completesAt ?? "");
      if (!completesAt || Date.parse(completesAt) > Date.now()) continue;
      this.db.updateTaskStatus(task.id, "ready", { summary: "Stability observation window completed" });
      this.db.appendEvent({
        projectId: task.projectId,
        taskId: task.id,
        runId: run.id,
        type: "run.observation_ready",
        payload: { completesAt },
      });
    }
  }

  private promoteCompletedRepairs(): void {
    for (const task of this.db.listTasksByStatus("parked")) {
      const run = this.db.getLatestRunForTask(task.id);
      const repairEvidence = run?.error?.postMergeRepair;
      if (!run || run.status !== "interrupted" || !repairEvidence ||
          typeof repairEvidence !== "object" || Array.isArray(repairEvidence)) continue;
      const repairTaskId = String((repairEvidence as JsonObject).repairTaskId ?? "");
      const repair = repairTaskId ? this.db.getTask(repairTaskId) : undefined;
      if (repair?.status !== "succeeded") continue;
      this.db.transaction(() => {
        if (this.db.getTask(task.id)?.status !== "parked") return;
        const currentRun = this.db.getRun(run.id);
        if (!currentRun || currentRun.status !== "interrupted" || currentRun.leaseOwner) return;
        this.db.updateTaskStatus(task.id, "succeeded", {
          summary: `Post-merge convergence restored by Repair Task ${repair.id}`,
          mergeSha: repair.mergeSha ?? task.mergeSha ?? currentRun.effects.merge?.externalRef ?? null,
        });
        currentRun.phase = "cleanup";
        currentRun.error = redactJson({
          ...currentRun.error,
          postMergeRepair: { repairTaskId: repair.id, resolvedAt: nowIso() },
        });
        if (!this.db.saveRun(currentRun, undefined)) throw new Error(`Run changed while resolving post-merge Repair: ${currentRun.id}`);
        this.db.appendEvent({
          projectId: task.projectId,
          taskId: task.id,
          runId: currentRun.id,
          type: "post_merge_repair.resolved",
          payload: { repairTaskId: repair.id },
        });
      });
    }
  }

  async runTask(taskId: string, preferredAgentId?: string): Promise<void> {
    if (this.inProcess.has(taskId)) return;
    this.inProcess.add(taskId);
    try {
      this.promoteTasks();
      let task = this.requireTask(taskId);
      let run = this.db.getLatestRunForTask(taskId);
      const cleanupRecovery = run?.status === "interrupted" && run.phase === "cleanup" && run.effects.merge?.status === "completed";
      if (["cancelled", "succeeded", "failed"].includes(task.status) && run?.status === "active") {
        if (!this.claimRun(run)) return;
        if (task.status === "succeeded") {
          run.phase = "cleanup";
          this.saveRun(run);
          await this.executeRun(run.id);
        } else {
          if (run.job?.pid) {
            const runtime = this.db.getAgent(run.job.agentId ?? run.agentId);
            if (runtime) this.adapterFactory(runtime).cancel(run.job.pid);
          }
          if (run.job?.agentId) this.db.releaseAgentSlot(run.job.id);
          run.job = undefined;
          run.phase = "done";
          run.status = "failed";
          run.leaseUntil = undefined;
          run.leaseOwner = undefined;
          this.saveRun(run);
          this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
          this.db.appendEvent({
            projectId: task.projectId,
            taskId: task.id,
            runId: run.id,
            type: "run.terminal_task_reconciled",
            payload: { taskStatus: task.status },
          });
        }
        return;
      }
      if (["paused", "awaiting_human", "cancelled", "succeeded", "failed"].includes(task.status) && !cleanupRecovery) return;
      if (run?.status === "interrupted" && (task.status === "ready" || cleanupRecovery)) {
        const resumed = this.db.transaction(() => {
          if (!cleanupRecovery && !this.canAdmitTask(task, run!.id)) return false;
          return this.db.resumeInterruptedRun(run!.id, this.leaseOwner, this.leaseTime());
        });
        if (!resumed) return;
        run = this.requireRun(run.id);
        if (!cleanupRecovery) this.db.updateTaskStatus(task.id, "running");
      } else if (!run || run.status !== "active") {
        run = await this.createRun(task, preferredAgentId);
      }
      if (!run || !this.claimRun(run)) return;
      task = this.requireTask(taskId);
      if (task.status === "ready") this.db.updateTaskStatus(task.id, "running");
      await this.executeRun(run.id);
      task = this.requireTask(taskId);
      if (task.status === "running" && this.db.getRun(run.id)?.status !== "active") {
        this.db.updateTaskStatus(task.id, "operational_blocked", { summary: "Run stopped without a terminal task state" });
      }
    } finally {
      this.inProcess.delete(taskId);
      this.recalculateAgentLoad();
    }
  }

  private async createRun(task: Task, preferredAgentId?: string): Promise<Run | undefined> {
    const project = this.requireProject(task.projectId);
    const preferred = preferredAgentId ? this.db.getAgent(preferredAgentId) : undefined;
    const agent = preferred ?? this.selectAgent("executor", task.requiredCapabilities);
    if (!agent) throw new Error(`No available executor for task ${task.id}`);
    // Phase prepare resolves and persists the authoritative base. Keeping Run
    // creation independent of Git I/O ensures even an initial fetch/repository
    // failure has durable retry state instead of becoming a stranded Task.
    let baseSha = "";
    try {
      baseSha = await branchHead(project.repoPath, projectBaseRef(project));
    } catch {
      // The prepare phase will retry the same fact under the normal Run policy.
    }
    const runId = newId("run");
    const workspaceId = newId("workspace");
    const logDir = join(this.db.paths.runs, runId);
    const workspacePath = join(this.db.paths.workspaces, project.id, task.id, runId);
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.db.paths.workspaces, project.id), { recursive: true, mode: 0o700 });
    const timestamp = nowIso();
    const run: Run = {
      id: runId,
      taskId: task.id,
      agentId: agent.id,
      workspaceId,
      phase: "prepare",
      status: "active",
      attempt: 1,
      repairCount: 0,
      rotationCount: 0,
      baseSha,
      ...(task.currentRevisionId ? { taskRevisionId: task.currentRevisionId } : {}),
      ...(task.currentRevisionId && this.db.getTaskRevision(task.currentRevisionId)
        ? { contextFingerprint: this.db.getTaskRevision(task.currentRevisionId)!.contextFingerprint }
        : {}),
      validation: [],
      metrics: {
        implementationMs: 0,
        controlMs: 0,
        validationMs: 0,
        reviewMs: 0,
        waitMs: 0,
        validationRuns: 0,
        repairRuns: 0,
        runtimeSwitches: 0,
      },
      effects: {},
      logDir,
      startedAt: timestamp,
      updatedAt: timestamp,
      leaseUntil: this.leaseTime(),
      leaseOwner: this.leaseOwner,
    };
    const workspace: Workspace = {
      id: workspaceId,
      projectId: project.id,
      taskId: task.id,
      runId,
      path: workspacePath,
      branch: `aec-s/${task.id}`,
      baseSha,
      status: "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = this.db.transaction(() => {
      if (this.db.getTask(task.id)?.status !== "ready") return false;
      if (!this.canAdmitTask(task)) return false;
      this.db.createRun(run);
      this.db.markAgentAssigned(agent.id);
      this.db.createWorkspace(workspace);
      this.db.updateTaskStatus(task.id, "running");
      return true;
    });
    return created ? run : undefined;
  }

  private canAdmitTask(task: Task, excludeRunId?: string): boolean {
    const project = this.requireProject(task.projectId);
    const activeRuns = this.db.listActiveRuns().filter((run) => run.id !== excludeRunId && run.phase !== "cleanup");
    const activeTasks = activeRuns
      .map((run) => this.db.getTask(run.taskId))
      .filter((candidate): candidate is Task => Boolean(candidate) && !["paused", "cancelled", "failed", "succeeded"].includes(candidate!.status));
    if (activeTasks.filter((candidate) => candidate.projectId === task.projectId).length >= project.maxConcurrency) return false;
    if (activeTasks.some((candidate) => candidate.projectId === task.projectId && tasksConflict(task.scope, candidate.scope))) return false;
    const capacityUsed = activeRuns.filter((run) => occupiesRuntimeCapacity(run.phase)).length;
    return capacityUsed < this.globalConcurrency;
  }

  private async executeRun(runId: string): Promise<void> {
    while (true) {
      const run = this.requireRun(runId);
      if (run.status !== "active" || run.phase === "done") return;
      const currentTask = this.requireTask(run.taskId);
      if (currentTask.status === "paused") {
        run.leaseUntil = undefined;
        run.leaseOwner = undefined;
        this.saveRun(run);
        return;
      }
      if (currentTask.status === "cancelled") {
        run.status = "failed";
        run.leaseUntil = undefined;
        run.leaseOwner = undefined;
        this.saveRun(run);
        this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
        return;
      }
      this.renewLease(run);
      try {
        await this.withLeaseHeartbeat(run, async () => {
          const controlStartedAt = Date.now();
          const controlPhase = isControlPhase(run.phase);
          if (await this.reconcileCompletedGitHubMerge(run)) return;
          if (this.reconcileContextRevision(run)) return;
          switch (run.phase) {
            case "prepare":
              await this.phasePrepare(run);
              break;
            case "execute":
              await this.phaseExecute(run);
              break;
            case "validate":
              await this.phaseValidate(run);
              break;
            case "review":
              await this.phaseReview(run);
              break;
            case "repair":
              await this.phaseRepair(run);
              break;
            case "publish":
              await this.phasePublish(run);
              break;
            case "remote_checks":
              await this.phaseRemoteChecks(run);
              break;
            case "merge":
              await this.phaseMerge(run);
              break;
            case "post_merge_smoke":
              await this.phasePostMergeSmoke(run);
              break;
            case "stability_observation":
              await this.phaseStabilityObservation(run);
              break;
            case "revert":
              await this.phaseRevert(run);
              break;
            case "cleanup":
              await this.phaseCleanup(run);
              break;
            default:
              throw new Error(`Unsupported run phase: ${run.phase}`);
          }
          if (controlPhase && run.status === "active") this.addRunMetric(run, "controlMs", Math.max(1, Date.now() - controlStartedAt));
        });
      } catch (error) {
        await this.handlePhaseError(this.requireRun(runId), error);
        const after = this.requireRun(runId);
        if (after.status !== "active") return;
      }
    }
  }

  private async phasePrepare(run: Run): Promise<void> {
    const task = this.requireTask(run.taskId);
    const project = this.requireProject(task.projectId);
    const workspace = this.requireWorkspace(run.workspaceId);
    await this.verifyEnvironmentContract(project, task, run);
    const baseSha = await createWorktree(project, workspace.path, workspace.branch);
    workspace.baseSha = baseSha;
    workspace.status = "active";
    this.db.updateWorkspaceBaseline(workspace.id, baseSha, "active");
    run.baseSha = baseSha;
    this.setPhase(run, "execute", { baseSha });
  }

  private async verifyEnvironmentContract(project: Project, task: Task, run: Run): Promise<void> {
    const requirements = task.environmentRequirements ?? [];
    if (requirements.length === 0) return;
    const agent = this.requireAgent(run.agentId);
    const verified: Array<{ id: string; version?: string }> = [];
    for (const requirement of requirements) {
      const component = project.environmentContract?.components.find((candidate) => candidate.id === requirement);
      if (!component) throw new Error(`Required Environment component is not declared: ${requirement}`);
      for (const capability of component.requiredCapabilities ?? []) {
        if (!agent.capabilities.includes(capability)) {
          throw new Error(`Environment component ${requirement} requires unavailable Agent capability: ${capability}`);
        }
      }
      let observed = "";
      if (component.command) {
        const command = resolveValidationCommand(component.command, project.repoPath);
        const result = await execCommand(command);
        if (result.exitCode !== 0 || result.timedOut) {
          throw new Error(`Environment component ${requirement} failed verification: ${redactText(result.stderr || result.stdout)}`);
        }
        observed = `${result.stdout}\n${result.stderr}`.trim();
      } else if (requirement === "node") {
        observed = process.version;
      } else if (requirement === "git") {
        const result = await execCommand({ program: "git", args: ["--version"], cwd: project.repoPath, timeoutSeconds: 15 });
        if (result.exitCode !== 0) throw new Error(`Environment component git failed verification: ${redactText(result.stderr)}`);
        observed = result.stdout.trim();
      } else {
        throw new Error(`Environment component ${requirement} requires a verification command`);
      }
      if (component.version && !this.environmentVersionMatches(component.version, observed)) {
        throw new Error(`Environment component ${requirement} version mismatch: expected ${component.version}, observed ${redactText(observed, 300)}`);
      }
      verified.push({ id: requirement, ...(component.version ? { version: component.version } : {}) });
    }
    this.db.appendEvent({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      type: "environment.verified",
      payload: { contractVersion: project.environmentContract?.version ?? 1, components: verified },
    });
  }

  private environmentVersionMatches(expected: string, observed: string): boolean {
    const minimum = expected.trim().match(/^>=\s*(\d+)(?:\.\d+\.\d+)?$/);
    if (minimum) {
      const actual = observed.match(/v?(\d+)(?:\.\d+\.\d+)?/);
      return Boolean(actual && Number(actual[1]) >= Number(minimum[1]));
    }
    return observed.includes(expected);
  }

  private reconcileContextRevision(run: Run): boolean {
    const task = this.requireTask(run.taskId);
    const current = task.currentRevisionId ? this.db.getTaskRevision(task.currentRevisionId) : undefined;
    if (!current || (run.taskRevisionId === current.id && run.contextFingerprint === current.contextFingerprint)) return false;
    const priorRevisionId = run.taskRevisionId;
    const hadRevisionBinding = Boolean(run.taskRevisionId && run.contextFingerprint);
    run.taskRevisionId = current.id;
    run.contextFingerprint = current.contextFingerprint;
    if (hadRevisionBinding && bearsRevisionEvidence(run.phase)) {
      run.phase = "validate";
      run.attempt = 1;
      run.validation = [];
      run.review = undefined;
      run.error = this.failureEvidence(run, { type: "context_revision_changed", priorRevisionId, revisionId: current.id });
    }
    this.saveRun(run);
    this.db.appendEvent({
      projectId: task.projectId,
      taskId: task.id,
      runId: run.id,
      type: "run.context_rebound",
      payload: { priorRevisionId, revisionId: current.id, fingerprint: current.contextFingerprint },
    });
    return hadRevisionBinding && bearsRevisionEvidence(run.phase);
  }

  private async phaseExecute(run: Run): Promise<void> {
    const { task, project, workspace, agent } = this.contextFor(run);
    const { path } = buildContextEnvelope(this.db, project, task, run, workspace, run.error);
    const schemas = writeSchemas(run.logDir);
    const adapter = this.adapterFactory(agent);
    const invocation = adapter.execute({
      kind: "execute",
      prompt: executionPrompt(path),
      workspacePath: workspace.path,
      runDir: run.logDir,
      schemaPath: schemas.worker,
      ...(run.runtimeSessionId ? { sessionId: run.runtimeSessionId } : {}),
    });
    const execution = await this.executeInvocation(run, invocation, "execute", agent.id);
    this.addRunMetric(run, "implementationMs", this.executionDuration(execution));
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const result = redactJson(parseStructuredOutput<WorkerResult>(resultPath));
    this.assertWorkerResult(result);
    this.db.recordAgentHealth(agent.id, true, agent.runtimeVersion);
    run.workerResult = result;
    run.workerResultPath = resultPath;
    const sessionId = adapter.extractSessionId(execution.stdoutPath);
    run.runtimeSessionId = sessionId ?? run.runtimeSessionId;
    run.codexSessionId = sessionId ?? run.codexSessionId;
    run.runtimeVersion = adapter.extractRuntimeVersion(execution.stdoutPath) ?? agent.runtimeVersion ?? run.runtimeVersion;
    this.addTokenUsage(run, adapter.extractTokenUsage(execution.stdoutPath));
    if (result.scopeExpansion && this.applyScopeExpansion(run, task, result)) return;
    run.error = result.status === "blocked"
      ? this.failureEvidence(run, { workerSummary: result.summary, notes: result.notes })
      : undefined;
    if (result.status === "blocked") {
      if (result.blocker && result.blocker.kind !== "technical") {
        this.escalateWorkerDecision(run, result);
        return;
      }
      this.setPhase(run, "repair");
    } else {
      this.setPhase(run, "validate", { attempt: 1, validation: [], review: undefined });
    }
  }

  private async phaseValidate(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    let revision = task.currentRevisionId ? this.db.getTaskRevision(task.currentRevisionId) : undefined;
    const paths = await changedPaths(workspace.path, run.baseSha);
    if (paths.length === 0) {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { type: "no_changes", message: "The task produced no file changes" }) });
      return;
    }
    const outside = outOfScopePaths(task, paths);
    if (outside.length > 0) {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { type: "scope_violation", paths: outside }) });
      return;
    }
    if (revision?.effectiveRiskClass !== "core" && paths.some((path) => matchesAny(path, project.highRiskGlobs))) {
      revision = this.db.createRiskElevationRevision(task.id, `Actual changed paths crossed the Project Risk Floor: ${paths.join(", ")}`);
      run.taskRevisionId = revision.id;
      run.contextFingerprint = revision.contextFingerprint;
      run.validation = [];
      run.review = undefined;
      this.saveRun(run);
      this.db.appendEvent({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        type: "policy.temporary_risk_elevation",
        payload: { mode: project.controlPolicy?.temporaryRiskElevation ?? "observe", revisionId: revision.id },
      });
    }
    const diffPath = join(run.logDir, `task-${run.id}.diff`);
    await writeDiff(workspace.path, run.baseSha, diffPath);
    assertFileSize(diffPath, 8 * 1024 * 1024, "Task diff");
    run.diffPath = diffPath;
    const validationTask = revision?.gateProfile.validation === "applicable"
      ? { ...task, requiresFullValidation: true }
      : task;
    const commands = authoritativeCommands(project, validationTask, paths);
    for (let index = run.validation.length; index < commands.length; index += 1) {
      const original = commands[index]!;
      const command = resolveValidationCommand(original, workspace.path);
      const name = `${command.program} ${command.args.join(" ")}`.trim();
      const pathsForCommand = validationPaths(
        run.logDir,
        index,
        `${command.program}-${run.attempt}-${run.repairCount}-${run.baseSha.slice(0, 12)}-${run.taskRevisionId ?? "unbound"}`,
      );
      const execution = await this.executeCommand(run, command, `validation-${index}`, {
        fixedPaths: pathsForCommand,
        allowFailure: true,
      });
      this.addRunMetric(run, "validationMs", this.executionDuration(execution));
      this.addRunMetric(run, "validationRuns", 1);
      if (execution.result.status === "spawn_error") {
        throw new Error(`Authoritative validation could not start: ${name}`);
      }
      const validation: ValidationResult = {
        name,
        command: original,
        status: execution.result.status === "timed_out" ? "timed_out" : execution.result.exitCode === 0 ? "passed" : "failed",
        exitCode: execution.result.exitCode,
        stdoutPath: execution.stdoutPath,
        stderrPath: execution.stderrPath,
        startedAt: execution.result.startedAt,
        finishedAt: execution.result.finishedAt,
      };
      run.validation.push(validation);
      this.saveRun(run);
      if (validation.status !== "passed") {
        this.setPhase(run, "repair", { error: this.failureEvidence(run, { type: "validation_failed", validation }) });
        return;
      }
    }
    const postValidationPaths = await changedPaths(workspace.path, run.baseSha);
    const postValidationOutside = outOfScopePaths(task, postValidationPaths);
    if (postValidationOutside.length > 0) {
      this.setPhase(run, "repair", {
        error: this.failureEvidence(run, { type: "scope_violation_after_validation", paths: postValidationOutside }),
      });
      return;
    }
    if (revision?.effectiveRiskClass !== "core" && postValidationPaths.some((path) => matchesAny(path, project.highRiskGlobs))) {
      revision = this.db.createRiskElevationRevision(task.id, `Validation generated paths that crossed the Project Risk Floor: ${postValidationPaths.join(", ")}`);
      run.taskRevisionId = revision.id;
      run.contextFingerprint = revision.contextFingerprint;
      run.validation = [];
      run.review = undefined;
      this.db.appendEvent({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        type: "policy.temporary_risk_elevation",
        payload: { mode: project.controlPolicy?.temporaryRiskElevation ?? "observe", revisionId: revision.id, source: "post_validation" },
      });
      this.setPhase(run, "validate", { attempt: 1 });
      return;
    }
    // The independent reviewer must see the authoritative post-validation diff,
    // including any generated file that is intentionally within Task scope.
    await writeDiff(workspace.path, run.baseSha, diffPath);
    assertFileSize(diffPath, 8 * 1024 * 1024, "Post-validation diff");
    if (revision?.gateProfile.review === "none") {
      this.setPhase(run, "publish", { attempt: 1, review: { completed: true, summary: "Review not required by Gate Profile", findings: [] } });
      return;
    }
    const executor = this.requireAgent(run.agentId);
    const excludedFamilies = revision?.gateProfile.review === "strict" &&
        (project.controlPolicy?.strictReviewMinRuntimeFamilies ?? 1) > 1
      ? new Set([executor.runtimeFamily ?? executor.adapter])
      : new Set<string>();
    const reviewer = this.selectAgent("reviewer", task.requiredCapabilities, new Set([run.agentId]), undefined, excludedFamilies);
    if (!reviewer) throw new Error(`No independent reviewer is available for task ${task.id}`);
    this.setPhase(run, "review", { attempt: 1 });
  }

  private async phaseReview(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    // Commit the already-validated executor state before exposing the
    // worktree to an independent reviewer. This gives AEC-S a deterministic
    // restoration point if a supposedly read-only adapter mutates files.
    await this.ensureCommit(run, project, task, workspace);
    const executor = this.requireAgent(run.agentId);
    const revision = task.currentRevisionId ? this.db.getTaskRevision(task.currentRevisionId) : undefined;
    const excludedFamilies = revision?.gateProfile.review === "strict" &&
        (project.controlPolicy?.strictReviewMinRuntimeFamilies ?? 1) > 1
      ? new Set([executor.runtimeFamily ?? executor.adapter])
      : new Set<string>();
    const priorReviewerId = run.review?.reviewerAgentId;
    const retainedCandidate = run.review?.completed === false && priorReviewerId
      ? this.db.getAgent(priorReviewerId)
      : undefined;
    const retainedReviewer = retainedCandidate &&
        retainedCandidate.enabled &&
        !["registered", "unavailable", "disabled", "offline"].includes(retainedCandidate.availability) &&
        retainedCandidate.roles.includes("reviewer") &&
        (retainedCandidate.adapter === "command" || retainedCandidate.runtimeCapabilities?.structuredOutput === true) &&
        (retainedCandidate.adapter === "command" || retainedCandidate.runtimeCapabilities?.reviewMode === true) &&
        retainedCandidate.currentLoad < retainedCandidate.maxConcurrency &&
        !excludedFamilies.has(retainedCandidate.runtimeFamily ?? retainedCandidate.adapter) &&
        task.requiredCapabilities.every((capability) => retainedCandidate.capabilities.includes(capability))
      ? retainedCandidate
      : undefined;
    const reviewer = retainedReviewer ?? this.selectAgent("reviewer", task.requiredCapabilities, new Set([run.agentId]), undefined, excludedFamilies);
    if (!reviewer) {
      throw new Error(`No independent reviewer is available for task ${task.id}`);
    }
    if (!retainedReviewer) {
      if (priorReviewerId && priorReviewerId !== reviewer.id) {
        run.attempt = 1;
        this.addRunMetric(run, "runtimeSwitches", 1);
        this.db.appendEvent({
          projectId: project.id,
          taskId: task.id,
          runId: run.id,
          type: "run.reviewer_rotated",
          payload: { fromAgentId: priorReviewerId, agentId: reviewer.id },
        });
      }
      run.review = { completed: false, summary: "Review in progress", findings: [], reviewerAgentId: reviewer.id };
      this.saveRun(run);
    }
    const reviewDir = join(this.db.paths.home, "reviews", run.id, `${run.attempt}-${run.repairCount}`);
    mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
    const { path } = buildContextEnvelope(this.db, project, task, run, workspace, undefined, {
      outputDir: reviewDir,
      reviewer: true,
    });
    const reviewDiff = join(reviewDir, "task.diff");
    if (!run.diffPath) throw new Error("Reviewer cannot run without a task diff");
    copyFileSync(run.diffPath, reviewDiff);
    const schemas = writeSchemas(reviewDir);
    const prompt = reviewer.adapter === "deepseek_harness"
      ? [
          reviewPrompt(path, reviewDiff),
          "The DSH reviewer composition has no filesystem tools. The authoritative packet follows.",
          "--- CONTEXT JSON ---",
          readTextBounded(path, 8 * 1024 * 1024, "Review context"),
          "--- TASK DIFF ---",
          readTextBounded(reviewDiff, 8 * 1024 * 1024, "Review diff"),
          "--- END PACKET ---",
        ].join("\n")
      : reviewPrompt(path, reviewDiff);
    if (Buffer.byteLength(prompt, "utf8") > 8 * 1024 * 1024) {
      throw new Error("Reviewer prompt exceeds 8 MiB");
    }
    const reviewerAdapter = this.adapterFactory(reviewer);
    const invocation = reviewerAdapter.review({
      kind: "review",
      prompt,
      workspacePath: workspace.path,
      runDir: reviewDir,
      schemaPath: schemas.review,
    });
    const execution = await this.executeInvocation(run, invocation, "review", reviewer.id);
    this.addRunMetric(run, "reviewMs", this.executionDuration(execution));
    const postReviewDiff = join(reviewDir, "post-review.diff");
    await writeDiff(workspace.path, run.baseSha, postReviewDiff);
    assertFileSize(postReviewDiff, 8 * 1024 * 1024, "Post-review diff");
    if (!readFileSync(reviewDiff).equals(readFileSync(postReviewDiff))) {
      await restoreWorkspaceHead(workspace.path);
      throw new AecError(
        AEC_ERROR.reviewerWorkspaceModified,
        `Reviewer ${reviewer.id} modified the task workspace`,
        { reviewerId: reviewer.id },
      );
    }
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const review = redactJson(parseStructuredOutput<ReviewResult>(resultPath));
    this.assertReviewResult(review);
    this.db.recordAgentHealth(reviewer.id, true, reviewer.runtimeVersion);
    this.addTokenUsage(run, reviewerAdapter.extractTokenUsage(execution.stdoutPath));
    run.review = { ...review, completed: true, reviewerAgentId: reviewer.id };
    const observedFindingIds = new Set<string>();
    for (const observation of review.findings) {
      const finding = this.db.createFinding({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        taskRevisionId: task.currentRevisionId ?? run.taskRevisionId ?? "unknown",
        severity: observation.severity,
        summary: observation.summary,
        ...(observation.category ? { rule: observation.category } : {}),
        ...(observation.file ? { file: observation.file } : {}),
        ...(observation.line ? { line: observation.line } : {}),
        ...(observation.evidence ? { evidence: observation.evidence } : {}),
        reviewerAgentId: reviewer.id,
      });
      observedFindingIds.add(finding.id);
      if (finding.status === "structurally_valid") {
        this.db.transitionFinding(finding.id, "verified", observation.evidence ?? "Authorized independent Review observation", reviewer.id);
      }
    }
    for (const prior of this.db.listFindings(task.id, "verified")) {
      if (prior.taskRevisionId !== (task.currentRevisionId ?? run.taskRevisionId) || observedFindingIds.has(prior.id)) continue;
      this.db.transitionFinding(prior.id, "resolved", `Independent reviewer ${reviewer.id} no longer reproduced the Finding after Repair`, reviewer.id);
    }
    if (this.db.hasVerifiedBlockingFindings(task.id, task.currentRevisionId ?? run.taskRevisionId)) {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { type: "verified_blocking_finding", review }) });
      return;
    }
    this.setPhase(run, "publish", { attempt: 1 });
  }

  private async phaseRepair(run: Run): Promise<void> {
    if (run.repairCount >= 2) {
      await this.rotateOrEscalate(run, run.error ?? { message: "Repair limit exhausted" });
      return;
    }
    const { task, project, workspace, agent } = this.contextFor(run);
    run.repairCount += 1;
    this.addRunMetric(run, "repairRuns", 1);
    const feedback = run.error;
    this.saveRun(run);
    const { path } = buildContextEnvelope(this.db, project, task, run, workspace, feedback);
    const schemas = writeSchemas(run.logDir);
    const adapter = this.adapterFactory(agent);
    const invocationOptions = {
      kind: "repair",
      prompt: repairPrompt(path),
      workspacePath: workspace.path,
      runDir: run.logDir,
      schemaPath: schemas.worker,
      ...(run.runtimeSessionId ?? run.codexSessionId ? { sessionId: run.runtimeSessionId ?? run.codexSessionId } : {}),
    } as const;
    const invocation = invocationOptions.sessionId
      ? adapter.resume(invocationOptions)
      : adapter.repair(invocationOptions);
    const execution = await this.executeInvocation(run, invocation, `repair-${run.repairCount}`, agent.id);
    this.addRunMetric(run, "implementationMs", this.executionDuration(execution));
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const result = redactJson(parseStructuredOutput<WorkerResult>(resultPath));
    this.assertWorkerResult(result);
    this.db.recordAgentHealth(agent.id, true, agent.runtimeVersion);
    run.workerResult = result;
    run.workerResultPath = resultPath;
    const sessionId = adapter.extractSessionId(execution.stdoutPath);
    run.runtimeSessionId = sessionId ?? run.runtimeSessionId;
    run.codexSessionId = sessionId ?? run.codexSessionId;
    run.runtimeVersion = adapter.extractRuntimeVersion(execution.stdoutPath) ?? agent.runtimeVersion ?? run.runtimeVersion;
    this.addTokenUsage(run, adapter.extractTokenUsage(execution.stdoutPath));
    if (result.scopeExpansion && this.applyScopeExpansion(run, task, result)) return;
    if (result.status === "blocked") {
      if (result.blocker && result.blocker.kind !== "technical") {
        this.escalateWorkerDecision(run, result);
        return;
      }
      run.error = this.failureEvidence(run, { type: "worker_blocked", summary: result.summary, notes: result.notes });
      this.saveRun(run);
      return;
    }
    if (await rebaseInProgress(workspace.path)) {
      await continueRebase(workspace.path);
      run.baseSha = await mergeBase(workspace.path, "HEAD", projectBaseRef(project));
      this.db.updateWorkspaceBaseline(workspace.id, run.baseSha);
      run.effects.commit = {
        operationId: this.operationId(project.id, task.id, run.id, "commit"),
        status: "completed",
        externalRef: await branchHead(workspace.path, "HEAD"),
      };
    }
    this.setPhase(run, "validate", { attempt: 1, validation: [], review: undefined, error: undefined });
  }

  private async phasePublish(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    const finalPaths = await changedPaths(workspace.path, run.baseSha);
    const outside = outOfScopePaths(task, finalPaths);
    if (outside.length > 0) {
      this.setPhase(run, "repair", {
        error: this.failureEvidence(run, { type: "scope_violation_after_gate", paths: outside }),
      });
      return;
    }
    await this.ensureCommit(run, project, task, workspace);
    if (project.deliveryMode === "github") await fetchRemote(project);
    const targetHead = await branchHead(project.repoPath, projectBaseRef(project));
    if (targetHead !== run.baseSha) {
      const forwardDrift = await isAncestor(project.repoPath, run.baseSha, targetHead);
      const targetChanges = await changedPathsBetween(project.repoPath, run.baseSha, targetHead);
      const relevant = !forwardDrift || changesAffectTask(task, targetChanges);
      const driftCommits = await commitCountBetween(project.repoPath, run.baseSha, targetHead);
      const driftSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(run.startedAt)) / 1_000));
      const exceedsCommitBudget = project.operationalConfig?.driftMaxCommits !== undefined &&
        driftCommits > project.operationalConfig.driftMaxCommits;
      const exceedsTimeBudget = project.operationalConfig?.driftMaxSeconds !== undefined &&
        driftSeconds > project.operationalConfig.driftMaxSeconds;
      if (exceedsCommitBudget || exceedsTimeBudget) {
        this.db.appendEvent({
          projectId: project.id,
          taskId: task.id,
          runId: run.id,
          type: "control.drift_budget_exceeded",
          payload: { driftCommits, driftSeconds, relevant },
        });
      }
      try {
        const rebasedTarget = await rebaseOntoTarget(project, workspace.path);
        run.baseSha = rebasedTarget;
        this.db.updateWorkspaceBaseline(workspace.id, rebasedTarget);
      } catch (error) {
        this.setPhase(run, "repair", {
          error: this.failureEvidence(run, {
            type: "rebase_conflict",
            relevant,
            targetHead,
            message: error instanceof Error ? error.message : String(error),
          }),
        });
        return;
      }
      run.effects.commit = {
        operationId: this.operationId(project.id, task.id, run.id, "commit"),
        status: "completed",
        externalRef: await branchHead(workspace.path, "HEAD"),
      };
      if (relevant) {
        this.setPhase(run, "validate", { attempt: 1, validation: [], review: undefined });
        return;
      }
      this.saveRun(run);
    }
    if (project.deliveryMode === "github") {
      await this.ensurePushAndPr(run, project, task, workspace);
      this.setPhase(run, "remote_checks");
    } else {
      this.setPhase(run, "merge");
    }
  }

  private async phaseRemoteChecks(run: Run): Promise<void> {
    const { project, workspace } = this.contextFor(run);
    const prRef = run.effects.pullRequest?.externalRef;
    if (!prRef) throw new Error("PR effect has no external reference");
    const prNumber = Number(prRef.split("#").at(-1));
    if (!Number.isFinite(prNumber)) throw new Error(`Invalid PR reference: ${prRef}`);
    const state = await inspectRequiredChecks(project, workspace.path, prNumber);
    if (state === "passed") {
      const existing = run.error?.externalWait;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        const startedAt = Date.parse(String((existing as JsonObject).startedAt ?? ""));
        if (Number.isFinite(startedAt)) this.addRunMetric(run, "waitMs", Date.now() - startedAt);
      }
      this.setPhase(run, "merge", { error: undefined });
      return;
    }
    const existing = run.error?.externalWait;
    const startedAt = existing && typeof existing === "object" && !Array.isArray(existing)
      ? String((existing as JsonObject).startedAt ?? nowIso())
      : nowIso();
    const deadlineAt = existing && typeof existing === "object" && !Array.isArray(existing)
      ? String((existing as JsonObject).deadlineAt ?? new Date(Date.now() + 1_800_000).toISOString())
      : new Date(Date.now() + 1_800_000).toISOString();
    if (Date.parse(deadlineAt) <= Date.now()) throw new Error(`Timed out waiting for GitHub checks on PR #${prNumber}`);
    const intervalMs = Math.max(250, Number(process.env.AEC_S_GITHUB_CHECK_POLL_MS ?? 5_000));
    const nextAttemptAt = new Date(Date.now() + intervalMs).toISOString();
    run.error = this.failureEvidence(run, { externalWait: { type: "github_checks", startedAt, deadlineAt, nextAttemptAt } });
    run.status = "interrupted";
    run.leaseUntil = undefined;
    run.leaseOwner = undefined;
    this.saveRun(run);
    this.updateTaskStatusFromControl(run, "operational_blocked", { summary: `Waiting for required checks until ${nextAttemptAt}` });
  }

  private async phaseMerge(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    const commitSha = await branchHead(workspace.path, "HEAD");
    const operationId = this.operationId(project.id, task.id, run.id, "merge");
    if (run.effects.merge?.status === "completed" && run.effects.merge.externalRef) {
      if (task.status !== "observing") this.updateTaskStatusFromControl(run, "observing", {
        summary: `Merged at ${run.effects.merge.externalRef}; post-merge convergence pending`,
        mergeSha: run.effects.merge.externalRef,
      });
      this.setPhase(run, "post_merge_smoke");
      return;
    }
    if (project.deliveryMode === "local") {
      const currentTarget = await branchHead(project.repoPath, project.targetBranch);
      if (currentTarget === commitSha) {
        this.setEffect(run, "merge", { operationId, status: "completed", externalRef: currentTarget });
        this.updateTaskStatusFromControl(run, "observing", { summary: `Merged at ${currentTarget}; post-merge convergence pending`, mergeSha: currentTarget });
        this.setPhase(run, "post_merge_smoke");
        return;
      }
    }
    this.setEffect(run, "merge", { operationId, status: "started" });
    try {
      let mergeSha: string;
      if (project.deliveryMode === "github") {
        const prRef = run.effects.pullRequest?.externalRef;
        if (!prRef) throw new Error("Cannot merge without a PR reference");
        const prNumber = Number(prRef.split("#").at(-1));
        const merged = await withProjectGitLock(project, async () => {
          await fetchRemoteUnlocked(project);
          const targetHead = await branchHead(project.repoPath, projectBaseRef(project));
          if (targetHead !== run.baseSha) return undefined;
          return await mergePullRequest(workspace.path, prNumber, commitSha);
        });
        if (!merged) {
          this.setEffect(run, "merge", { operationId, status: "pending" });
          this.setPhase(run, "publish");
          return;
        }
        mergeSha = merged.mergeSha;
      } else {
        const currentTarget = await branchHead(project.repoPath, project.targetBranch);
        if (currentTarget !== run.baseSha) {
          this.setPhase(run, "publish");
          return;
        }
        mergeSha = await localMerge(project, workspace.branch, commitSha);
      }
      this.setEffect(run, "merge", { operationId, status: "completed", externalRef: mergeSha });
      this.updateTaskStatusFromControl(run, "observing", {
        summary: `Merged at ${mergeSha}; post-merge convergence pending`,
        mergeSha,
      });
      this.setPhase(run, "post_merge_smoke");
    } catch (error) {
      if (project.deliveryMode === "local" && isAecError(error, AEC_ERROR.gitFastForwardRequired)) {
        this.setEffect(run, "merge", { operationId, status: "pending" });
        this.setPhase(run, "publish");
        return;
      }
      this.setEffect(run, "merge", {
        operationId,
        status: "uncertain",
        externalRef: run.effects.merge?.externalRef,
      });
      throw error;
    }
  }

  private async phasePostMergeSmoke(run: Run): Promise<void> {
    const { project } = this.contextFor(run);
    if (project.deliveryMode === "local") {
      await withProjectGitLock(project, async () => await this.phasePostMergeSmokeLocked(run));
      return;
    }
    await this.phasePostMergeSmokeLocked(run);
  }

  private async phasePostMergeSmokeLocked(run: Run): Promise<void> {
    const { task, project } = this.contextFor(run);
    const mergeSha = run.effects.merge?.externalRef;
    if (!mergeSha) throw new Error("Post-merge smoke requires an authoritative merge SHA");
    const operationId = this.operationId(project.id, task.id, run.id, "post_merge_smoke");
    await verifyMergedRevision(project, this.requireWorkspace(run.workspaceId).path, mergeSha);
    if (run.effects.postMergeSmoke?.status !== "completed") {
      this.setEffect(run, "postMergeSmoke", { operationId, status: "started", externalRef: mergeSha });
      const commands = project.postMergeSmoke ?? [];
      for (let index = 0; index < commands.length; index += 1) {
        const original = commands[index]!;
        const smokeRoot = project.deliveryMode === "github" ? this.requireWorkspace(run.workspaceId).path : project.repoPath;
        const command = resolveValidationCommand(original, smokeRoot);
        const label = `post-merge-smoke-${index}`;
        const smokePaths = validationPaths(run.logDir, index, label);
        const execution = await this.executeCommand(run, command, label, { fixedPaths: smokePaths, allowFailure: true });
        this.addRunMetric(run, "validationMs", this.executionDuration(execution));
        this.addRunMetric(run, "validationRuns", 1);
        const mutated = await workspaceHasChanges(smokeRoot);
        if (execution.result.status === "spawn_error") {
          throw new Error(`Post-merge smoke could not start: ${original.program}`);
        }
        if (execution.result.status !== "completed" || execution.result.exitCode !== 0 || mutated) {
          this.setEffect(run, "postMergeSmoke", { operationId, status: "completed", externalRef: `failed:${mergeSha}` });
          this.db.appendEvent({ projectId: project.id, taskId: task.id, runId: run.id, type: "post_merge_smoke.failed", payload: { mergeSha, index, mutated } });
          this.setPhase(run, "revert", { error: this.failureEvidence(run, { type: "post_merge_smoke_failed", mergeSha, command: original, mutated }) });
          return;
        }
      }
      this.setEffect(run, "postMergeSmoke", { operationId, status: "completed", externalRef: mergeSha });
      this.db.appendEvent({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        type: "post_merge_smoke.passed",
        payload: { mergeSha, registeredCommands: commands.length },
      });
    }
    this.setPhase(run, "stability_observation");
  }

  private async phaseStabilityObservation(run: Run): Promise<void> {
    const { project } = this.contextFor(run);
    const seconds = project.operationalConfig?.stabilityObservationSeconds ?? 0;
    const existing = run.error?.stabilityObservation;
    if (seconds > 0 && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
      const completesAt = new Date(Date.now() + seconds * 1_000).toISOString();
      run.error = this.failureEvidence(run, { stabilityObservation: { completesAt } });
      run.status = "interrupted";
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.updateTaskStatusFromControl(run, "observing", { summary: `Stability observation until ${completesAt}` });
      return;
    }
    const mergeSha = run.effects.merge?.externalRef;
    this.updateTaskStatusFromControl(run, "succeeded", {
      summary: run.workerResult?.summary ?? `Completed by run ${run.id}`,
      ...(mergeSha ? { mergeSha } : {}),
    });
    this.setPhase(run, "cleanup", { error: undefined });
  }

  private async phaseRevert(run: Run): Promise<void> {
    const { task, project } = this.contextFor(run);
    const policy = project.controlPolicy?.autoRevert ?? "observe";
    const mergeSha = run.effects.merge?.externalRef;
    const successors = this.db.listTasks(project.id).filter((candidate) =>
      candidate.dependsOn.includes(task.id) && !["cancelled", "failed", "parked"].includes(candidate.status));
    const canRevert = policy === "enforce" && task.revertSafe === true && project.deliveryMode === "local" &&
      Boolean(mergeSha) && successors.length === 0;
    if (canRevert && run.effects.revert?.status !== "completed") {
      const operationId = this.operationId(project.id, task.id, run.id, "revert");
      this.setEffect(run, "revert", { operationId, status: "started", externalRef: mergeSha });
      try {
        const revertSha = await revertMergedTask(project, mergeSha!, task.id);
        this.setEffect(run, "revert", { operationId, status: "completed", externalRef: revertSha });
      } catch (error) {
        this.setEffect(run, "revert", { operationId, status: "uncertain", externalRef: mergeSha });
        throw error;
      }
    }
    const repairId = `repair-${task.id.slice(0, 100)}-${fingerprint({ taskId: task.id, mergeSha }).slice(0, 16)}`;
    if (!this.db.getTask(repairId)) {
      const repair = this.db.createTask({
        id: repairId,
        projectId: project.id,
        title: `Repair post-merge smoke: ${task.title}`,
        goal: `Diagnose and repair the post-merge smoke failure recorded by Run ${run.id}.`,
        scope: task.scope,
        constraints: [...task.constraints, "Preserve the failed Run evidence and do not broaden Scope without a Proposal."],
        acceptanceCriteria: [...task.acceptanceCriteria, "Registered post-merge smoke passes"],
        validationCommands: task.validationCommands,
        requiredCapabilities: task.requiredCapabilities,
        proposedRiskClass: "core",
        environmentRequirements: task.environmentRequirements,
        revertSafe: task.revertSafe,
        priority: Math.min(100, task.priority + 1),
      });
      this.db.updateTaskStatus(repair.id, "parked", { summary: "Created from post-merge smoke evidence; awaiting controlled admission" });
    }
    const existingDecision = this.db.listDecisions(project.id, "pending")
      .find((decision) => decision.taskId === repairId && decision.kind === "failure_exhausted");
    const decision = existingDecision ?? this.db.createDecision({
      projectId: project.id,
      taskId: repairId,
      kind: "failure_exhausted",
      title: `Post-merge smoke failed: ${task.title}`,
      body: JSON.stringify({
        failedTaskId: task.id,
        repairTaskId: repairId,
        runId: run.id,
        deliveryMode: project.deliveryMode,
        mergeSha,
        reverted: canRevert,
      }, null, 2),
      options: ["resume_task", "cancel_task"],
    });
    run.error = this.failureEvidence(run, {
      ...run.error,
      postMergeRepair: { repairTaskId: repairId },
    });
    this.updateTaskStatusFromControl(run, "parked", {
      summary: canRevert
        ? `Post-merge smoke failed; merge reverted and Repair Task ${repairId} awaits Decision ${decision.id}`
        : `Post-merge smoke failed; Repair Task ${repairId} awaits Decision ${decision.id}`,
    });
    run.status = "interrupted";
    run.leaseUntil = undefined;
    run.leaseOwner = undefined;
    this.saveRun(run);
    this.db.appendEvent({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      type: canRevert ? "revert.completed" : "revert.parked",
      payload: { policy, revertSafe: task.revertSafe ?? false, mergeSha, repairTaskId: repairId, successors: successors.map((item) => item.id) },
    });
  }

  private async reconcileCompletedGitHubMerge(run: Run): Promise<boolean> {
    const { task, project, workspace } = this.contextFor(run);
    if (project.deliveryMode !== "github") return false;
    if (!["started", "pending", "uncertain"].includes(run.effects.merge?.status ?? "")) return false;
    const prRef = run.effects.pullRequest?.status === "completed"
      ? run.effects.pullRequest.externalRef
      : undefined;
    if (!prRef) return false;
    const prNumber = Number(prRef.split("#").at(-1));
    if (!Number.isFinite(prNumber)) throw new Error(`Invalid PR reference: ${prRef}`);
    const expectedHeadSha = run.effects.push?.status === "completed"
      ? run.effects.push.externalRef
      : undefined;
    const merged = await reconcileMergedPullRequest(workspace.path, prNumber, expectedHeadSha);
    if (!merged) return false;
    const operationId = this.operationId(project.id, task.id, run.id, "merge");
    this.setEffect(run, "merge", { operationId, status: "completed", externalRef: merged.mergeSha });
    this.updateTaskStatusFromControl(run, "observing", {
      summary: `Merged at ${merged.mergeSha}; post-merge convergence pending`,
      mergeSha: merged.mergeSha,
    });
    this.setPhase(run, "post_merge_smoke", { error: undefined });
    return true;
  }

  private async phaseCleanup(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    if (task.status !== "succeeded" && run.effects.merge?.status === "completed" && run.effects.merge.externalRef) {
      this.updateTaskStatusFromControl(run, "observing", {
        summary: `Recovered merge ${run.effects.merge.externalRef}; post-merge convergence pending`,
        mergeSha: run.effects.merge.externalRef,
      });
      this.setPhase(run, "post_merge_smoke");
      return;
    }
    if (task.status !== "succeeded") throw new Error("Cleanup cannot precede post-merge convergence");
    if (project.deliveryMode === "github") await deleteRemoteTaskBranch(project, workspace.path, workspace.branch);
    await cleanupWorktree(project, workspace.path, workspace.branch);
    this.db.updateWorkspaceStatus(workspace.id, "cleaned");
    run.phase = "done";
    run.status = "completed";
    run.job = undefined;
    run.updatedAt = nowIso();
    run.leaseUntil = undefined;
    run.leaseOwner = undefined;
    this.saveRun(run);
    this.db.appendEvent({
      projectId: project.id,
      taskId: run.taskId,
      runId: run.id,
      type: "run.completed",
      payload: { merge: run.effects.merge?.externalRef },
    });
  }

  private updateTaskStatusFromControl(
    run: Run,
    status: Task["status"],
    extra?: { summary?: string | null; mergeSha?: string | null },
  ): void {
    if (!this.db.updateTaskStatusUnlessControlled(run.taskId, status, extra)) {
      throw new Error(`Task control state changed during ${run.phase}`);
    }
  }

  private async ensureCommit(run: Run, project: Project, task: Task, workspace: Workspace): Promise<void> {
    const operationId = this.operationId(project.id, task.id, run.id, "commit");
    if (run.effects.commit?.status === "completed") {
      const head = await branchHead(workspace.path, "HEAD");
      const dirty = await workspaceHasChanges(workspace.path);
      const committedDiff = await changedPathsBetween(workspace.path, run.baseSha, head);
      if (head === run.effects.commit.externalRef && !dirty && committedDiff.length > 0) return;
    }
    this.setEffect(run, "commit", { operationId, status: "started" });
    try {
      const sha = await commitTask(workspace.path, task);
      this.setEffect(run, "commit", { operationId, status: "completed", externalRef: sha });
    } catch (error) {
      this.setEffect(run, "commit", { operationId, status: "uncertain" });
      throw error;
    }
  }

  private async ensurePushAndPr(run: Run, project: Project, task: Task, workspace: Workspace): Promise<void> {
    const headSha = await branchHead(workspace.path, "HEAD");
    const pushId = this.operationId(project.id, task.id, run.id, "push");
    const remoteHead = await remoteTaskBranchHead(project, workspace.path, workspace.branch);
    if (remoteHead === headSha) {
      this.setEffect(run, "push", { operationId: pushId, status: "completed", externalRef: headSha });
    } else {
      this.setEffect(run, "push", { operationId: pushId, status: "started" });
      try {
        const pushed = await pushTaskBranch(project, workspace.path, workspace.branch);
        this.setEffect(run, "push", { operationId: pushId, status: "completed", externalRef: pushed });
      } catch (error) {
        this.setEffect(run, "push", { operationId: pushId, status: "uncertain" });
        throw error;
      }
    }
    const prId = this.operationId(project.id, task.id, run.id, "pullRequest");
    const pr = await createOrGetPullRequest(project, task, workspace.path, workspace.branch);
    this.setEffect(run, "pullRequest", {
      operationId: prId,
      status: "completed",
      externalRef: `${pr.url}#${pr.number}`,
    });
  }

  private async executeInvocation(run: Run, invocation: AgentInvocation, label: string, agentId: string): Promise<JobExecution> {
    const workspace = this.db.getWorkspace(run.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${run.workspaceId}`);
    const runtime = this.requireAgent(agentId);
    const authorityHeadSha = run.job?.authorityHeadSha ?? await branchHead(workspace.path, "HEAD");
    const guardedInvocation: AgentInvocation = {
      ...invocation,
      command: {
        ...invocation.command,
        env: {
          ...invocation.command.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.pushurl",
          GIT_CONFIG_VALUE_0: "aec-s-runtime-authority-disabled://origin",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
        },
      },
    };
    const execution = await this.executeCommand(
      run,
      guardedInvocation.command,
      label,
      {
        stdin: guardedInvocation.stdin,
        structuredOutputPath: guardedInvocation.structuredOutputPath,
        agentId,
        authorityHeadSha,
        environmentProfile: runtime.adapter === "command"
          ? "restricted"
          : runtime.adapter,
      },
    );
    const postHeadSha = await branchHead(workspace.path, "HEAD");
    if (postHeadSha !== authorityHeadSha) {
      throw new AecError(
        AEC_ERROR.runtimeAuthorityViolation,
        `Runtime authority violation: Agent ${agentId} changed Git HEAD during ${label}`,
        { agentId, label },
      );
    }
    return execution;
  }

  private async executeCommand(
    run: Run,
    command: CommandSpec,
    label: string,
    options: {
      fixedPaths?: { stdout: string; stderr: string; result: string; input: string };
      stdin?: string;
      structuredOutputPath?: string;
      agentId?: string;
      authorityHeadSha?: string;
      environmentProfile?: ChildEnvironmentProfile;
      allowFailure?: boolean;
    } = {},
  ): Promise<JobExecution> {
    let job = run.job;
    let input: JobInput;
    if (!job) {
      const suffix = newId("job");
      const jobId = newId("job");
      const paths = options.fixedPaths ?? {
        stdout: join(run.logDir, `${label}-${suffix}.stdout.log`),
        stderr: join(run.logDir, `${label}-${suffix}.stderr.log`),
        result: join(run.logDir, `${label}-${suffix}.result.json`),
        input: join(run.logDir, `${label}-${suffix}.input.json`),
      };
      if (options.fixedPaths && [paths.stdout, paths.stderr, paths.result, paths.input].some((path) => existsSync(path))) {
        const previous = newId("previous");
        for (const path of [paths.stdout, paths.stderr, paths.result, paths.input]) {
          if (existsSync(path)) renameSync(path, `${path}.${previous}`);
        }
      }
      input = {
        command,
        ...(options.environmentProfile ? { environmentProfile: options.environmentProfile } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        resultPath: paths.result,
      };
      if (options.agentId) await this.waitForAgentSlot(options.agentId, run.id, jobId, run);
      try {
        job = startSupervisedJob(input, paths.input, jobId, (pending) => {
          run.job = {
            ...pending,
            label,
            ...(options.structuredOutputPath ? { structuredOutputPath: options.structuredOutputPath } : {}),
            ...(options.agentId ? { agentId: options.agentId } : {}),
            ...(options.authorityHeadSha ? { authorityHeadSha: options.authorityHeadSha } : {}),
          };
          this.saveRun(run);
        });
        if (options.authorityHeadSha) job.authorityHeadSha = options.authorityHeadSha;
      } catch (error) {
        if (options.agentId) this.db.releaseAgentSlot(jobId);
        throw error;
      }
      job.label = label;
      if (options.structuredOutputPath) job.structuredOutputPath = options.structuredOutputPath;
      if (options.agentId) {
        job.agentId = options.agentId;
      }
      run.job = job;
      this.saveRun(run);
    } else {
      input = readJson<JobInput>(job.inputPath);
      if (!job.pid && !existsSync(job.resultPath)) {
        const persisted = job;
        const started = startSupervisedJob(input, job.inputPath, job.id, (pending) => {
          run.job = { ...persisted, ...pending };
          this.saveRun(run);
        });
        job = { ...persisted, ...started };
        run.job = job;
        this.saveRun(run);
      }
    }
    let result: JobResult;
    try {
      result = await waitForJob(job, command.timeoutSeconds ?? 300, () => this.renewLease(run));
    } catch (error) {
      if (job.agentId) this.db.releaseAgentSlot(job.id);
      run.job = undefined;
      this.saveRun(run);
      throw error;
    }
    const execution: JobExecution = {
      result,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      ...(job.structuredOutputPath ? { structuredOutputPath: job.structuredOutputPath } : {}),
    };
    run.job = undefined;
    if (job.agentId) this.db.releaseAgentSlot(job.id);
    this.saveRun(run);
    if (!options.allowFailure && (result.status !== "completed" || result.exitCode !== 0)) {
      const stderr = existsSync(input.stderrPath) ? readFileSync(input.stderrPath, "utf8").trim() : "";
      const stdout = existsSync(input.stdoutPath) ? readFileSync(input.stdoutPath, "utf8").trim() : "";
      throw new Error(`${label} failed (${result.status}, exit ${String(result.exitCode)}): ${(stderr || stdout).slice(-4000)}`);
    }
    return execution;
  }

  private async handlePhaseError(run: Run, error: unknown): Promise<void> {
    const classified = classifyPhaseError(error, run.phase);
    const { message } = classified;
    const currentTask = this.requireTask(run.taskId);
    if (currentTask.status === "cancelled") {
      run.job = undefined;
      run.status = "failed";
      run.updatedAt = nowIso();
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
      return;
    }
    if (currentTask.status === "paused") {
      run.job = undefined;
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      return;
    }
    if (classified.category === "agent_capacity") {
      const previous = run.error?.externalWait;
      const startedAt = previous && typeof previous === "object" && !Array.isArray(previous)
        ? String((previous as JsonObject).startedAt ?? nowIso())
        : nowIso();
      const nextAttemptAt = new Date(Date.now() + 1_000).toISOString();
      run.error = this.failureEvidence(run, {
        externalWait: { type: "agent_capacity", startedAt, nextAttemptAt, message },
      });
      run.job = undefined;
      run.status = "interrupted";
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatusUnlessControlled(run.taskId, "operational_blocked", {
        summary: `Waiting for Runtime capacity until ${nextAttemptAt}`,
      });
      return;
    }
    const operationalRetry = run.error?.operationalRetry;
    run.error = this.failureEvidence(run, {
      phase: run.phase,
      message,
      ...(operationalRetry !== undefined ? { operationalRetry } : {}),
    });
    run.job = undefined;
    if (classified.category === "runtime_authority") {
      const task = currentTask;
      const offenderId = run.phase === "review" ? run.review?.reviewerAgentId : run.agentId;
      if (offenderId) this.db.updateAgent(offenderId, { availability: "unavailable" });
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
      this.db.appendEvent({
        projectId: task.projectId,
        taskId: run.taskId,
        runId: run.id,
        type: "runtime.authority_violation",
        payload: { phase: run.phase, agentId: offenderId ?? null, message },
      });
      if (run.phase === "review") {
        run.review = undefined;
        run.attempt = 1;
        this.saveRun(run);
        const executor = this.requireAgent(run.agentId);
        const revision = task.currentRevisionId ? this.db.getTaskRevision(task.currentRevisionId) : undefined;
        const excludedFamilies = revision?.gateProfile.review === "strict" &&
            (this.requireProject(task.projectId).controlPolicy?.strictReviewMinRuntimeFamilies ?? 1) > 1
          ? new Set([executor.runtimeFamily ?? executor.adapter])
          : new Set<string>();
        const alternate = this.selectAgent(
          "reviewer",
          task.requiredCapabilities,
          new Set([run.agentId, ...(offenderId ? [offenderId] : [])]),
          undefined,
          excludedFamilies,
        );
        if (alternate) {
          run.review = { completed: false, summary: "Review reassigned after authority violation", findings: [], reviewerAgentId: alternate.id };
          this.addRunMetric(run, "runtimeSwitches", 1);
          this.saveRun(run);
          return;
        }
        this.escalateSecurityViolation(run, message, offenderId);
        return;
      }
      await this.rotateOrEscalate(run, run.error);
      return;
    }
    if (classified.category === "reviewer_mutation") {
      const reviewerId = run.review?.reviewerAgentId;
      if (reviewerId) this.db.updateAgent(reviewerId, { availability: "unavailable" });
      this.scheduleOperationalRetry(run, message);
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
      return;
    }
    if (["execute", "repair"].includes(run.phase)) {
      this.db.recordAgentHealth(run.agentId, false);
      if (run.attempt < 3) {
        run.attempt += 1;
        run.phase = "execute";
        this.saveRun(run);
        return;
      }
      await this.rotateOrEscalate(run, run.error);
      return;
    }
    if (run.phase === "review") {
      const reviewerId = run.review?.reviewerAgentId;
      if (reviewerId) this.db.recordAgentHealth(reviewerId, false);
    }
    if (run.phase === "review" && run.attempt < 3) {
      run.attempt += 1;
      this.saveRun(run);
      return;
    }
    if (classified.category === "github_checks") {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { phase: run.phase, message }) });
      return;
    }
    const task = this.requireTask(run.taskId);
    if (run.phase === "cleanup" && task.status === "succeeded") {
      this.scheduleCleanupRetry(run, message);
    } else {
      this.scheduleOperationalRetry(run, message);
    }
    const workspace = this.db.getWorkspace(run.workspaceId);
    if (workspace) this.db.updateWorkspaceStatus(workspace.id, "preserved");
    this.db.appendEvent({
      taskId: run.taskId,
      runId: run.id,
      type: "run.operational_blocked",
      payload: { phase: run.phase, message },
    });
  }

  private scheduleCleanupRetry(run: Run, message: string): void {
    const task = this.requireTask(run.taskId);
    const project = this.requireProject(task.projectId);
    const previous = run.error?.operationalRetry;
    const previousCount = previous && typeof previous === "object" && !Array.isArray(previous)
      ? Number((previous as JsonObject).count ?? 0)
      : 0;
    const count = previousCount + 1;
    if (count > this.maxOperationalRetries) {
      const decision = this.db.listDecisions(project.id, "pending")
        .find((candidate) => candidate.taskId === task.id && candidate.title.startsWith("Workspace cleanup failed:")) ??
        this.db.createDecision({
          projectId: project.id,
          taskId: task.id,
          kind: "failure_exhausted",
          title: `Workspace cleanup failed: ${task.title}`,
          body: JSON.stringify({ runId: run.id, workspaceId: run.workspaceId, retries: previousCount, message }, null, 2),
          options: ["record"],
        });
      run.status = "failed";
      run.error = this.failureEvidence(run, { cleanupFailure: { decisionId: decision.id, retries: previousCount, message } });
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      return;
    }
    const delayMs = Math.min(this.operationalRetryBaseMs * 2 ** Math.max(0, count - 1), 5 * 60_000);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    run.error = this.failureEvidence(run, { operationalRetry: { count, nextAttemptAt, message } });
    run.status = "interrupted";
    run.leaseUntil = undefined;
    run.leaseOwner = undefined;
    this.saveRun(run);
    this.db.appendEvent({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      type: "cleanup.retry_scheduled",
      payload: { count, nextAttemptAt, message },
    });
  }

  private scheduleOperationalRetry(run: Run, message: string): void {
    const task = this.requireTask(run.taskId);
    const previous = run.error?.operationalRetry;
    const previousCount = previous && typeof previous === "object" && !Array.isArray(previous)
      ? Number((previous as JsonObject).count ?? 0)
      : 0;
    const count = previousCount + 1;
    if (count > this.maxOperationalRetries) {
      this.escalateOperationalFailure(run, message, previousCount);
      return;
    }
    const delayMs = Math.min(this.operationalRetryBaseMs * 2 ** Math.max(0, count - 1), 5 * 60_000);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    run.error = this.failureEvidence(run, {
      ...run.error,
      operationalRetry: { count, nextAttemptAt, message },
    });
    run.status = "interrupted";
    run.updatedAt = nowIso();
    run.leaseUntil = undefined;
    run.leaseOwner = undefined;
    this.saveRun(run);
    this.db.updateTaskStatus(task.id, "operational_blocked", {
      summary: `Automatic retry ${count}/${this.maxOperationalRetries} scheduled for ${nextAttemptAt}: ${message}`,
    });
    this.db.appendEvent({
      projectId: task.projectId,
      taskId: task.id,
      runId: run.id,
      type: "run.retry_scheduled",
      payload: { count, nextAttemptAt, message },
    });
  }

  private escalateSecurityViolation(run: Run, message: string, offenderId?: string): void {
    const task = this.requireTask(run.taskId);
    const project = this.requireProject(task.projectId);
    this.db.transaction(() => {
      const existing = this.db.listDecisions(project.id, "pending")
        .find((decision) => decision.taskId === task.id && decision.kind === "failure_exhausted");
      const decision = existing ?? this.db.createDecision({
        projectId: project.id,
        taskId: task.id,
        kind: "failure_exhausted",
        title: `Runtime authority violation: ${task.title}`,
        body: JSON.stringify({ message, offenderId, runId: run.id, phase: run.phase }, null, 2),
        options: ["resume_task", "replace_task", "cancel_task"],
      });
      run.status = "failed";
      run.updatedAt = nowIso();
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatus(task.id, "awaiting_human", { summary: `Security Decision required: ${decision.id}` });
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
    });
  }

  private escalateOperationalFailure(run: Run, message: string, retries: number): void {
    const task = this.requireTask(run.taskId);
    this.db.transaction(() => {
      const existing = this.db.listDecisions(task.projectId, "pending")
        .find((decision) => decision.taskId === task.id && decision.kind === "failure_exhausted");
      const decision = existing ?? this.db.createDecision({
        projectId: task.projectId,
        taskId: task.id,
        kind: "failure_exhausted",
        title: `Operational retries exhausted: ${task.title}`,
        body: JSON.stringify({ message, retries, runId: run.id, phase: run.phase }, null, 2),
        options: ["resume_task", "replace_task", "cancel_task"],
      });
      run.status = "failed";
      run.updatedAt = nowIso();
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatus(task.id, "awaiting_human", { summary: `Decision required: ${decision.id}` });
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
    });
  }

  private async rotateOrEscalate(run: Run, evidence: JsonObject): Promise<void> {
    const task = this.requireTask(run.taskId);
    const project = this.requireProject(task.projectId);
    const history = Array.isArray(run.error?.agentHistory) ? (run.error.agentHistory as string[]) : [];
    const excluded = new Set([...history, run.agentId]);
    const alternate = run.rotationCount < 2
      ? this.selectAgent("executor", task.requiredCapabilities, excluded)
      : undefined;
    if (alternate) {
      const previousAgent = this.requireAgent(run.agentId);
      run.rotationCount += 1;
      this.addRunMetric(run, "runtimeSwitches", 1);
      run.attempt = 1;
      run.repairCount = 0;
      run.agentId = alternate.id;
      run.codexSessionId = undefined;
      run.runtimeSessionId = undefined;
      run.validation = [];
      run.review = undefined;
      run.phase = "execute";
      run.error = { ...evidence, agentHistory: [...excluded] };
      this.saveRun(run);
      this.db.appendEvent({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        type: "run.agent_rotated",
        payload: {
          fromAgentId: previousAgent.id,
          fromRuntimeFamily: previousAgent.runtimeFamily ?? previousAgent.adapter,
          agentId: alternate.id,
          runtimeFamily: alternate.runtimeFamily ?? alternate.adapter,
          rotationCount: run.rotationCount,
        },
      });
      return;
    }
    this.db.appendEvent({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      type: "controller.overhead",
      payload: { repairCount: run.repairCount, rotationCount: run.rotationCount, evidence },
    });
    if (project.controlPolicy?.circuitBreaker === "enforce") {
      run.status = "interrupted";
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatus(task.id, "circuit_broken", { summary: "Local circuit breaker stopped a non-converging control loop" });
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
      return;
    }
    this.db.transaction(() => {
      const existing = this.db.listDecisions(project.id, "pending")
        .find((item) => item.taskId === task.id && item.kind === "failure_exhausted");
      const decision = existing ?? this.db.createDecision({
        projectId: project.id,
        taskId: task.id,
        kind: "failure_exhausted",
        title: `Task failed after available Agent attempts: ${task.title}`,
        body: JSON.stringify({ technicalSummary: evidence, runId: run.id }, null, 2),
        options: ["retry_with_agent", "replace_task", "cancel_task"],
      });
      run.status = "failed";
      run.updatedAt = nowIso();
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatus(task.id, "awaiting_human", { summary: `Decision required: ${decision.id}` });
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
    });
  }

  resolveDecision(decisionId: string, resolution: JsonObject): Decision {
    resolution = redactJson(resolution);
    return this.db.transaction(() => {
      const decision = this.db.getDecision(decisionId);
      if (!decision) throw new Error(`Decision not found: ${decisionId}`);
      if (decision.status === "resolved") throw new Error(`Decision is already resolved: ${decisionId}`);
      if (decision.taskId) {
        const action = String(resolution.action ?? "");
        let effectiveAction = action;
        if (action === "approve_scope") {
          if (decision.kind !== "policy" || !decision.title.startsWith("Scope Expansion Proposal:")) {
            throw new Error(`Decision ${decision.id} is not a Scope Expansion decision`);
          }
          let proposal: unknown;
          try {
            proposal = (JSON.parse(decision.body) as { proposal?: unknown }).proposal;
          } catch {
            throw new Error(`Decision ${decision.id} has invalid Scope Expansion evidence`);
          }
          if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
            throw new Error(`Decision ${decision.id} has no Scope Expansion Proposal`);
          }
          this.db.createScopeExpansionRevision(decision.taskId, proposal as {
            addWriteGlobs: string[]; addWatchGlobs: string[]; evidence: string;
          });
          effectiveAction = "resume_task";
        }
        if (effectiveAction === "retry_with_agent" || effectiveAction === "resume_task") {
          const run = this.db.getLatestRunForTask(decision.taskId);
          if (run) {
            const task = this.requireTask(decision.taskId);
            if (effectiveAction === "retry_with_agent") {
              const requestedId = typeof resolution.agentId === "string" ? resolution.agentId : undefined;
              const requested = requestedId ? this.db.getAgent(requestedId) : undefined;
              if (requestedId && (!requested || !requested.enabled || requested.availability !== "available" ||
                !requested.roles.includes("executor") ||
                !task.requiredCapabilities.every((capability) => requested.capabilities.includes(capability)))) {
                throw new Error(`Requested retry Agent is unavailable or ineligible: ${requestedId}`);
              }
              const alternate = requested ?? this.selectAgent("executor", task.requiredCapabilities, new Set([run.agentId]));
              if (alternate) run.agentId = alternate.id;
            }
            run.status = "active";
            run.phase = "execute";
            run.attempt = 1;
            run.repairCount = 0;
            run.rotationCount = 0;
            run.codexSessionId = undefined;
            run.runtimeSessionId = undefined;
            run.validation = [];
            run.review = undefined;
            run.job = undefined;
            run.taskRevisionId = task.currentRevisionId;
            run.contextFingerprint = task.currentRevisionId
              ? this.db.getTaskRevision(task.currentRevisionId)?.contextFingerprint
              : undefined;
            run.error = { humanResolution: resolution };
            run.leaseUntil = undefined;
            run.leaseOwner = undefined;
            if (!this.db.saveRun(run, undefined)) throw new Error(`Run changed while resolving Decision: ${run.id}`);
          }
          this.db.updateTaskStatus(decision.taskId, "ready", { summary: "Human decision applied" });
        } else if (action === "cancel_task") {
          this.db.updateTaskStatus(decision.taskId, "cancelled", { summary: "Cancelled by Human decision" });
        } else if (action === "replace_task") {
          const replacement = resolution.replacement;
          if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) {
            throw new Error("replace_task requires a replacement Task definition");
          }
          this.submitGraph(decision.projectId, [{
            ...(replacement as TaskInput),
            projectId: decision.projectId,
            replacesTaskId: decision.taskId,
          }]);
        } else if (action === "record" && decision.title.startsWith("Workspace cleanup failed:")) {
          // The main branch already converged; this Decision acknowledges preserved cleanup evidence.
        } else if (["failure_exhausted", "architecture", "product", "tradeoff"].includes(decision.kind)) {
          throw new Error(`Decision ${decision.id} requires a supported action`);
        }
      }
      return this.db.resolveDecision(decisionId, resolution);
    });
  }

  applyDirective(input: {
    action: "pause" | "resume" | "reprioritize" | "cancel";
    projectId?: string;
    taskIds?: string[];
    tags?: string[];
    priority?: number;
  }): Task[] {
    const tasks = this.db.listTasks(input.projectId).filter((task) => {
      if (input.taskIds && !input.taskIds.includes(task.id)) return false;
      if (input.tags && !input.tags.some((tag) => task.scope.tags.includes(tag))) return false;
      return true;
    });
    for (const task of tasks) {
      if (input.action === "resume") {
        const pending = this.db.listDecisions(task.projectId, "pending").some((decision) => decision.taskId === task.id);
        if (pending) throw new Error(`Task ${task.id} has an unresolved Human Decision`);
      }
    }
    for (const task of tasks) {
      if (input.action === "pause" && !["succeeded", "failed", "cancelled"].includes(task.status)) {
        this.db.updateTaskStatus(task.id, "paused");
      } else if (input.action === "resume" && ["paused", "operational_blocked", "awaiting_human", "parked", "circuit_broken"].includes(task.status)) {
        this.db.updateTaskStatus(task.id, "ready");
      } else if (input.action === "cancel" && !["succeeded", "failed", "cancelled"].includes(task.status)) {
        const run = this.db.getLatestRunForTask(task.id);
        if (run?.job?.pid) {
          const runtime = this.db.getAgent(run.job.agentId ?? run.agentId);
          if (runtime) this.adapterFactory(runtime).cancel(run.job.pid);
          if (run.job.agentId) this.db.releaseAgentSlot(run.job.id);
          this.db.appendEvent({
            projectId: task.projectId,
            taskId: task.id,
            runId: run.id,
            type: "runtime.cancel_requested",
            payload: { runtimeFamily: runtime?.runtimeFamily ?? runtime?.adapter ?? "unknown" },
          });
        }
        this.db.updateTaskStatus(task.id, "cancelled");
      } else if (input.action === "reprioritize") {
        if (input.priority === undefined || input.priority < -100 || input.priority > 100) {
          throw new Error("reprioritize requires priority between -100 and 100");
        }
        this.db.updateTaskPriority(task.id, input.priority);
      }
    }
    return tasks.map((task) => this.requireTask(task.id));
  }

  private selectAgent(
    role: AgentRole,
    capabilities: string[],
    excluded = new Set<string>(),
    loadOverride?: Map<string, number>,
    excludedFamilies = new Set<string>(),
  ): Agent | undefined {
    return selectDeterministicAgent({
      agents: this.db.listAgents(),
      role,
      capabilities,
      excluded,
      excludedFamilies,
      ...(loadOverride ? { loadOverride } : {}),
    });
  }

  private recalculateAgentLoad(): void {
    const jobs = new Map<string, Run>();
    for (const run of this.db.listRunsWithJobs()) {
      if (!run.job?.agentId) continue;
      const resultExists = existsSync(run.job.resultPath);
      const alive = run.job.pid ? processAlive(run.job.pid) : false;
      if (!resultExists && alive) {
        jobs.set(run.job.id, run);
        this.db.ensureAgentSlot(run.job.agentId, run.id, run.job.id);
      }
    }
    for (const lease of this.db.listAgentLeases()) {
      const age = Date.now() - Date.parse(lease.createdAt);
      if (!jobs.has(lease.jobId) && age > 30_000) this.db.releaseAgentSlot(lease.jobId);
    }
  }

  private async waitForAgentSlot(agentId: string, runId: string, jobId: string, run: Run): Promise<void> {
    const deadline = Date.now() + 1_000;
    let nextHeartbeat = Date.now();
    while (Date.now() < deadline) {
      if (this.db.reserveAgentSlot(agentId, runId, jobId)) return;
      if (Date.now() >= nextHeartbeat) {
        this.renewLease(run);
        nextHeartbeat = Date.now() + 10_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new AecError(
      AEC_ERROR.agentCapacityUnavailable,
      `Agent capacity unavailable: ${agentId}`,
      { agentId },
    );
  }

  private failureEvidence(run: Run, value: JsonObject): JsonObject {
    const agentHistory = Array.isArray(run.error?.agentHistory) ? run.error.agentHistory : [];
    return redactJson({ ...value, agentHistory });
  }

  private escalateWorkerDecision(run: Run, result: WorkerResult): void {
    const task = this.requireTask(run.taskId);
    const blocker = result.blocker!;
    if (blocker.kind === "technical") throw new Error("Technical blockers must use the Repair flow");
    this.db.transaction(() => {
      const existing = this.db.listDecisions(task.projectId, "pending").find((item) => item.taskId === task.id);
      const decision = existing ?? this.db.createDecision({
        projectId: task.projectId,
        taskId: task.id,
        kind: blocker.kind as "architecture" | "product" | "tradeoff",
        title: blocker.question,
        body: JSON.stringify({ summary: result.summary, notes: result.notes, runId: run.id }, null, 2),
        options: ["resume_task", "replace_task", "cancel_task"],
      });
      run.status = "failed";
      run.error = this.failureEvidence(run, { type: "human_decision_required", decisionId: decision.id, blocker });
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatus(task.id, "awaiting_human", { summary: `Decision required: ${decision.id}` });
      this.db.updateWorkspaceStatus(run.workspaceId, "preserved");
    });
  }

  private contextFor(run: Run): { task: Task; project: Project; workspace: Workspace; agent: Agent } {
    const task = this.requireTask(run.taskId);
    return {
      task,
      project: this.requireProject(task.projectId),
      workspace: this.requireWorkspace(run.workspaceId),
      agent: this.requireAgent(run.agentId),
    };
  }

  private setPhase(run: Run, phase: Run["phase"], patch: Partial<Run> = {}): void {
    Object.assign(run, patch, { phase, updatedAt: nowIso(), leaseUntil: this.leaseTime() });
    this.saveRun(run);
    const task = this.db.getTask(run.taskId);
    this.db.appendEvent({
      projectId: task?.projectId,
      taskId: run.taskId,
      runId: run.id,
      type: "run.phase_changed",
      payload: { phase },
    });
  }

  private setEffect(run: Run, key: keyof RunEffects, effect: EffectState): void {
    run.effects = { ...run.effects, [key]: effect };
    this.saveRun(run);
    const task = this.db.getTask(run.taskId);
    this.db.appendEvent({
      projectId: task?.projectId,
      taskId: run.taskId,
      runId: run.id,
      type: `effect.${key}.${effect.status}`,
      payload: { operationId: effect.operationId, externalRef: effect.externalRef },
    });
  }

  private renewLease(run: Run): void {
    const leaseUntil = this.leaseTime();
    if (!this.db.renewRunLease(run.id, this.leaseOwner, leaseUntil)) {
      throw new AecError(AEC_ERROR.runLeaseLost, `Run lease lost: ${run.id}`, { runId: run.id });
    }
    run.leaseUntil = leaseUntil;
    run.leaseOwner = this.leaseOwner;
  }

  private async withLeaseHeartbeat<T>(run: Run, operation: () => Promise<T>): Promise<T> {
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      try {
        this.renewLease(run);
      } catch (error) {
        heartbeatError ??= error;
      }
    }, this.leaseHeartbeatMs);
    heartbeat.unref();
    try {
      const value = await operation();
      if (heartbeatError) this.renewLease(run);
      return value;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private leaseTime(): string {
    // Each phase renews periodically, including while Git/GitHub subprocesses
    // are blocked, so another daemon cannot mistake a long operation for abandonment.
    return new Date(Date.now() + 900_000).toISOString();
  }

  private canClaimRun(run: Run): boolean {
    if (!run.leaseOwner || run.leaseOwner === this.leaseOwner) return true;
    if (!run.leaseUntil || Date.parse(run.leaseUntil) <= Date.now()) return true;
    const ownerPid = Number(run.leaseOwner.split(":", 1)[0]);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch {
      return true;
    }
  }

  private claimRun(run: Run): boolean {
    if (!this.canClaimRun(run)) return false;
    const claimed = this.db.claimRun(run.id, run.leaseOwner, this.leaseOwner, this.leaseTime());
    if (claimed) run.leaseOwner = this.leaseOwner;
    return claimed;
  }

  private saveRun(run: Run): void {
    run.updatedAt = nowIso();
    if (!this.db.saveRun(run, this.leaseOwner)) {
      throw new AecError(AEC_ERROR.runLeaseLost, `Run lease lost: ${run.id}`, { runId: run.id });
    }
  }

  private executionDuration(execution: JobExecution): number {
    return Math.max(0, Date.parse(execution.result.finishedAt) - Date.parse(execution.result.startedAt));
  }

  private addRunMetric(
    run: Run,
    key: Exclude<keyof NonNullable<Run["metrics"]>, "tokenUsage">,
    value: number,
  ): void {
    run.metrics ??= {
      implementationMs: 0,
      controlMs: 0,
      validationMs: 0,
      reviewMs: 0,
      waitMs: 0,
      validationRuns: 0,
      repairRuns: 0,
      runtimeSwitches: 0,
    };
    run.metrics[key] += value;
    this.saveRun(run);
  }

  private addTokenUsage(run: Run, usage: { input?: number; output?: number; total?: number } | undefined): void {
    if (!usage) return;
    run.metrics ??= {
      implementationMs: 0,
      controlMs: 0,
      validationMs: 0,
      reviewMs: 0,
      waitMs: 0,
      validationRuns: 0,
      repairRuns: 0,
      runtimeSwitches: 0,
    };
    const previous = run.metrics.tokenUsage ?? {};
    run.metrics.tokenUsage = {
      input: (previous.input ?? 0) + (usage.input ?? 0),
      output: (previous.output ?? 0) + (usage.output ?? 0),
      total: (previous.total ?? 0) + (usage.total ?? 0),
    };
    this.saveRun(run);
  }

  private operationId(projectId: string, taskId: string, runId: string, effect: string): string {
    return `${projectId}:${taskId}:${runId}:${effect}`;
  }

  private assertWorkerResult(result: WorkerResult): void {
    if (!result || !["complete", "blocked"].includes(result.status) || typeof result.summary !== "string" || !Array.isArray(result.notes)) {
      throw new Error("Worker returned an invalid structured result");
    }
    const workerKeys = new Set(["status", "summary", "notes", "blocker", "scopeExpansion"]);
    if (!Object.hasOwn(result, "blocker") || !Object.hasOwn(result, "scopeExpansion") ||
        Object.keys(result).some((key) => !workerKeys.has(key)) ||
        !result.notes.every((note) => typeof note === "string")) {
      throw new Error("Worker result does not conform to the AEC-S output Schema");
    }
    if (result.blocker && (
      !["technical", "architecture", "product", "tradeoff"].includes(result.blocker.kind) ||
      typeof result.blocker.question !== "string" ||
      result.blocker.question.length === 0
    )) {
      throw new Error("Worker returned an invalid blocker");
    }
    if (result.scopeExpansion && (
      !Array.isArray(result.scopeExpansion.addWriteGlobs) ||
      !Array.isArray(result.scopeExpansion.addWatchGlobs) ||
      !result.scopeExpansion.addWriteGlobs.every((value) => typeof value === "string") ||
      !result.scopeExpansion.addWatchGlobs.every((value) => typeof value === "string") ||
      typeof result.scopeExpansion.evidence !== "string" ||
      result.scopeExpansion.evidence.trim().length === 0
    )) throw new Error("Worker returned an invalid Scope Expansion Proposal");
  }

  private applyScopeExpansion(run: Run, task: Task, result: WorkerResult): boolean {
    const proposal = result.scopeExpansion;
    if (!proposal) return false;
    const candidateScope = {
      writeGlobs: [...new Set([...task.scope.writeGlobs, ...proposal.addWriteGlobs])],
      watchGlobs: [...new Set([...(task.scope.watchGlobs ?? []), ...proposal.addWatchGlobs])],
      tags: task.scope.tags,
    };
    taskInputSchema.parse({
      projectId: task.projectId,
      title: task.title,
      goal: task.goal,
      scope: candidateScope,
      acceptanceCriteria: task.acceptanceCriteria,
    });
    const project = this.requireProject(task.projectId);
    const mode = project.controlPolicy?.scopeCalibration ?? "observe";
    this.db.appendEvent({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      type: "policy.scope_calibration",
      payload: { mode, proposal },
    });
    if (mode === "observe") {
      const existing = this.db.listDecisions(project.id, "pending")
        .find((decision) => decision.taskId === task.id && decision.kind === "policy" && decision.title.startsWith("Scope Expansion Proposal:"));
      const decision = existing ?? this.db.createDecision({
        projectId: project.id,
        taskId: task.id,
        kind: "policy",
        title: `Scope Expansion Proposal: ${task.title}`,
        body: JSON.stringify({ runId: run.id, proposal }, null, 2),
        options: ["approve_scope", "resume_task", "cancel_task"],
      });
      run.workerResult = result;
      run.status = "interrupted";
      run.error = this.failureEvidence(run, { type: "scope_expansion_observed", decisionId: decision.id });
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
      this.db.updateTaskStatus(task.id, "awaiting_human", { summary: `Scope Expansion requires Decision ${decision.id}` });
      return true;
    }
    const revision = this.db.createScopeExpansionRevision(task.id, proposal);
    run.taskRevisionId = revision.id;
    run.contextFingerprint = revision.contextFingerprint;
    run.workerResult = result;
    run.error = this.failureEvidence(run, {
      type: "scope_expansion_accepted",
      evidence: proposal.evidence,
      revisionId: revision.id,
    });
    run.phase = "execute";
    run.attempt = 1;
    run.validation = [];
    run.review = undefined;
    this.saveRun(run);
    return true;
  }

  private assertReviewResult(result: ReviewResult): void {
    const reviewKeys = new Set(["verdict", "completed", "summary", "findings"]);
    if (!result || !Object.hasOwn(result, "verdict") || result.completed !== true ||
      (result.verdict !== null && result.verdict !== undefined && !["pass", "fail"].includes(result.verdict)) ||
      typeof result.summary !== "string" || !Array.isArray(result.findings) ||
      Object.keys(result).some((key) => !reviewKeys.has(key))) {
      throw new Error("Reviewer returned an invalid structured result");
    }
    const findingKeys = new Set(["severity", "summary", "file", "line", "requiredChange", "evidence", "category"]);
    for (const finding of result.findings) {
      if (!finding || !["blocking", "warning"].includes(finding.severity) || typeof finding.summary !== "string" ||
          Object.keys(finding).some((key) => !findingKeys.has(key)) ||
          [...findingKeys].some((key) => !Object.hasOwn(finding, key)) ||
          (finding.file !== null && finding.file !== undefined && typeof finding.file !== "string") ||
          (finding.line !== null && finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) ||
          (finding.evidence !== null && finding.evidence !== undefined && typeof finding.evidence !== "string") ||
          (finding.category !== null && finding.category !== undefined && typeof finding.category !== "string")) {
        throw new Error("Review Finding does not conform to the AEC-S output Schema");
      }
    }
    const hasBlocking = result.findings.some((finding) => finding.severity === "blocking");
    if (result.verdict === "fail" && !hasBlocking) {
      throw new Error("A failed Review must include at least one blocking Finding");
    }
    if (result.verdict === "pass" && hasBlocking) {
      throw new Error("A passing Review cannot include a blocking Finding");
    }
    if (result.verdict !== "pass" && result.verdict !== "fail") {
      throw new Error("A completed Review must provide a pass or fail verdict");
    }
  }

  private requireProject(id: string): Project {
    const value = this.db.getProject(id);
    if (!value) throw new Error(`Project not found: ${id}`);
    return value;
  }

  private requireTask(id: string): Task {
    const value = this.db.getTask(id);
    if (!value) throw new Error(`Task not found: ${id}`);
    return value;
  }

  private requireRun(id: string): Run {
    const value = this.db.getRun(id);
    if (!value) throw new Error(`Run not found: ${id}`);
    return value;
  }

  private requireWorkspace(id: string): Workspace {
    const value = this.db.getWorkspace(id);
    if (!value) throw new Error(`Workspace not found: ${id}`);
    return value;
  }

  private requireAgent(id: string): Agent {
    const value = this.db.getAgent(id);
    if (!value) throw new Error(`Agent not found: ${id}`);
    return value;
  }
}
