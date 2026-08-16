import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AecDatabase } from "./db.js";
import type {
  Agent,
  AgentRole,
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
import { adapterFor, type AgentInvocation } from "./adapters/agent.js";
import { buildContextEnvelope, executionPrompt, repairPrompt, reviewPrompt } from "./context.js";
import {
  branchHead,
  changedPaths,
  changedPathsBetween,
  changesAffectTask,
  cleanupWorktree,
  commitTask,
  continueRebase,
  createWorktree,
  fetchRemote,
  fetchRemoteUnlocked,
  localMerge,
  outOfScopePaths,
  projectBaseRef,
  rebaseInProgress,
  rebaseOntoTarget,
  workspaceHasChanges,
  writeDiff,
  withProjectGitLock,
} from "./git.js";
import { tasksConflict } from "./glob.js";
import { parseStructuredOutput, readJson } from "./files.js";
import { processAlive, startSupervisedJob, waitForJob } from "./job.js";
import { authoritativeCommands, resolveValidationCommand, validationPaths } from "./validation.js";
import { writeSchemas } from "./schemas.js";
import { taskInputSchema } from "./input.js";
import {
  createOrGetPullRequest,
  deleteRemoteTaskBranch,
  mergePullRequest,
  pushTaskBranch,
  remoteTaskBranchHead,
  waitForRequiredChecks,
} from "./github.js";
import { redactJson, redactText } from "./redaction.js";

type EngineOptions = {
  globalConcurrency?: number;
  leaseHeartbeatMs?: number;
  operationalRetryBaseMs?: number;
  maxOperationalRetries?: number;
  agentHealthcheckIntervalMs?: number;
};

type JobExecution = {
  result: JobResult;
  stdoutPath: string;
  stderrPath: string;
  structuredOutputPath?: string;
};

export class AecEngine {
  private readonly globalConcurrency: number;
  private readonly leaseHeartbeatMs: number;
  private readonly operationalRetryBaseMs: number;
  private readonly maxOperationalRetries: number;
  private readonly agentHealthcheckIntervalMs: number;
  private readonly inProcess = new Set<string>();
  private readonly leaseOwner = `${process.pid}:${newId("lease")}`;
  private schedulerCycles = 0;
  private lastAgentHealthcheckAt = 0;

  constructor(readonly db: AecDatabase, options: EngineOptions = {}) {
    this.globalConcurrency = options.globalConcurrency ?? 2;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 10_000;
    this.operationalRetryBaseMs = options.operationalRetryBaseMs ?? 5_000;
    this.maxOperationalRetries = options.maxOperationalRetries ?? 5;
    this.agentHealthcheckIntervalMs = options.agentHealthcheckIntervalMs ?? 60_000;
  }

  submitGraph(projectId: string, inputs: TaskInput[]): Task[] {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (inputs.length === 0) throw new Error("Task graph cannot be empty");
    const parsedInputs = inputs.map((input) => taskInputSchema.parse(input) as TaskInput);
    const normalized = parsedInputs.map((input) => ({ ...input, id: input.id ?? newId("task"), projectId }));
    const graphIds = new Set(normalized.map((input) => input.id!));
    if (graphIds.size !== normalized.length) throw new Error("Task graph contains duplicate IDs");
    for (const input of normalized) this.validateTaskInput(input);
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
      return tasks;
    });
  }

  private validateTaskInput(input: TaskInput): void {
    if (!input.title.trim()) throw new Error("Task title is required");
    if (!input.goal.trim()) throw new Error("Task goal is required");
    if (input.acceptanceCriteria.length === 0) throw new Error(`Task ${input.id ?? input.title} requires acceptance criteria`);
    if (input.priority !== undefined && (input.priority < -100 || input.priority > 100)) {
      throw new Error(`Task priority must be between -100 and 100: ${input.id ?? input.title}`);
    }
    for (const command of input.validationCommands ?? []) this.validateCommand(command);
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
    for (const task of this.db.listTasks()) {
      if (task.status !== "queued") continue;
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
    this.promoteTasks();
    this.recalculateAgentLoad();
    const allActiveRuns = this.db.listActiveRuns();
    const cleanupRuns = allActiveRuns.filter((run) => run.phase === "cleanup");
    const capacityRuns = allActiveRuns.filter(
      (run) => run.phase !== "cleanup" && this.db.getTask(run.taskId)?.status !== "paused",
    );
    const activeRuns = [...cleanupRuns, ...capacityRuns].filter((run) => this.canClaimRun(run));
    const work: Array<Promise<void>> = [];
    for (const run of activeRuns) {
      if (this.inProcess.has(run.taskId)) continue;
      work.push(this.runTaskSafely(run.taskId));
    }
    const activeTasks = capacityRuns
      .map((run) => this.db.getTask(run.taskId))
      .filter((task): task is Task => Boolean(task));
    const selected = [...activeTasks];
    const reservedLoads = new Map(this.db.listAgents().map((agent) => [agent.id, agent.currentLoad]));
    let slots = Math.max(0, this.globalConcurrency - capacityRuns.length);
    for (const task of this.db.listRunnableTasks()) {
      if (slots === 0) break;
      if (task.status !== "ready" || this.inProcess.has(task.id) || allActiveRuns.some((run) => run.taskId === task.id)) continue;
      const project = this.db.getProject(task.projectId);
      if (!project) continue;
      const projectActive = selected.filter((item) => item.projectId === project.id).length;
      if (projectActive >= project.maxConcurrency) continue;
      if (selected.some((other) => other.projectId === task.projectId && tasksConflict(task.scope, other.scope))) continue;
      const reservedAgent = this.selectAgent("executor", task.requiredCapabilities, new Set(), reservedLoads);
      if (!reservedAgent) continue;
      reservedLoads.set(reservedAgent.id, (reservedLoads.get(reservedAgent.id) ?? 0) + 1);
      selected.push(task);
      slots -= 1;
      work.push(this.runTaskSafely(task.id, reservedAgent.id));
    }
    // One operational failure must not terminate the daemon or cause a CLI
    // caller to close the database while sibling Runs are still writing.
    await Promise.allSettled(work);
    return work.length;
  }

  async runUntilIdle(maxCycles = 100): Promise<void> {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      const count = await this.runOnce();
      if (count === 0) return;
    }
    throw new Error(`AEC did not become idle after ${maxCycles} scheduler cycles`);
  }

  private async runTaskSafely(taskId: string, preferredAgentId?: string): Promise<void> {
    try {
      await this.runTask(taskId, preferredAgentId);
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      if (message.startsWith("Run lease lost:")) return;
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

  async refreshAgentAvailability(): Promise<void> {
    for (const agent of this.db.listAgents()) {
      if (!agent.enabled || agent.availability === "offline") continue;
      let healthy = false;
      try {
        healthy = (await adapterFor(agent).healthcheck()).ok;
      } catch {
        healthy = false;
      }
      const availability = healthy ? "available" : "degraded";
      if (agent.availability !== availability) this.db.updateAgent(agent.id, { availability });
    }
    this.lastAgentHealthcheckAt = Date.now();
  }

  private async refreshAgentAvailabilityIfDue(): Promise<void> {
    if (Date.now() - this.lastAgentHealthcheckAt < this.agentHealthcheckIntervalMs) return;
    await this.refreshAgentAvailability();
  }

  private promoteOperationalRetries(): void {
    for (const task of this.db.listTasks()) {
      if (task.status !== "operational_blocked") continue;
      const run = this.db.getLatestRunForTask(task.id);
      const retry = run?.error?.operationalRetry;
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

  async runTask(taskId: string, preferredAgentId?: string): Promise<void> {
    if (this.inProcess.has(taskId)) return;
    this.inProcess.add(taskId);
    try {
      this.promoteTasks();
      let task = this.requireTask(taskId);
      let run = this.db.getLatestRunForTask(taskId);
      const cleanupRecovery = run?.status === "interrupted" && run.phase === "cleanup" && run.effects.merge?.status === "completed";
      if (["paused", "awaiting_human", "cancelled", "succeeded", "failed"].includes(task.status) && !cleanupRecovery) return;
      if (run?.status === "interrupted" && (task.status === "ready" || cleanupRecovery)) {
        const leaseUntil = this.leaseTime();
        if (!this.db.resumeInterruptedRun(run.id, this.leaseOwner, leaseUntil)) return;
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
      validation: [],
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
      branch: `aec/${task.id}`,
      baseSha,
      status: "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = this.db.transaction(() => {
      if (this.db.getTask(task.id)?.status !== "ready") return false;
      this.db.createRun(run);
      this.db.createWorkspace(workspace);
      this.db.updateTaskStatus(task.id, "running");
      return true;
    });
    return created ? run : undefined;
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
            case "cleanup":
              await this.phaseCleanup(run);
              break;
            default:
              throw new Error(`Unsupported run phase: ${run.phase}`);
          }
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
    const baseSha = await createWorktree(project, workspace.path, workspace.branch);
    workspace.baseSha = baseSha;
    workspace.status = "active";
    this.db.updateWorkspaceBaseline(workspace.id, baseSha, "active");
    run.baseSha = baseSha;
    this.setPhase(run, "execute", { baseSha });
  }

  private async phaseExecute(run: Run): Promise<void> {
    const { task, project, workspace, agent } = this.contextFor(run);
    const { path } = buildContextEnvelope(this.db, project, task, run, workspace, run.error);
    const schemas = writeSchemas(run.logDir);
    const adapter = adapterFor(agent);
    const invocation = adapter.invocation({
      kind: "execute",
      prompt: executionPrompt(path),
      workspacePath: workspace.path,
      runDir: run.logDir,
      schemaPath: schemas.worker,
    });
    const execution = await this.executeInvocation(run, invocation, "execute", agent.id);
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const result = redactJson(parseStructuredOutput<WorkerResult>(resultPath));
    this.assertWorkerResult(result);
    run.workerResult = result;
    run.workerResultPath = resultPath;
    run.codexSessionId = adapter.extractSessionId(execution.stdoutPath) ?? run.codexSessionId;
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
    const diffPath = join(run.logDir, `task-${run.id}.diff`);
    await writeDiff(workspace.path, run.baseSha, diffPath);
    run.diffPath = diffPath;
    const commands = authoritativeCommands(project, task, paths);
    for (let index = run.validation.length; index < commands.length; index += 1) {
      const original = commands[index]!;
      const command = resolveValidationCommand(original, workspace.path);
      const name = `${command.program} ${command.args.join(" ")}`.trim();
      const pathsForCommand = validationPaths(run.logDir, index, `${command.program}-${run.attempt}-${run.repairCount}`);
      const execution = await this.executeCommand(run, command, `validation-${index}`, {
        fixedPaths: pathsForCommand,
        allowFailure: true,
      });
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
    // The independent reviewer must see the authoritative post-validation diff,
    // including any generated file that is intentionally within Task scope.
    await writeDiff(workspace.path, run.baseSha, diffPath);
    const reviewer = this.selectAgent("reviewer", task.requiredCapabilities, new Set([run.agentId]));
    if (!reviewer) throw new Error(`No independent reviewer is available for task ${task.id}`);
    this.setPhase(run, "review", { attempt: 1 });
  }

  private async phaseReview(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    const reviewer = this.selectAgent("reviewer", task.requiredCapabilities, new Set([run.agentId]));
    if (!reviewer) {
      throw new Error(`No independent reviewer is available for task ${task.id}`);
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
    const invocation = adapterFor(reviewer).invocation({
      kind: "review",
      prompt: reviewPrompt(path, reviewDiff),
      workspacePath: workspace.path,
      runDir: reviewDir,
      schemaPath: schemas.review,
    });
    const execution = await this.executeInvocation(run, invocation, "review", reviewer.id);
    const postReviewDiff = join(reviewDir, "post-review.diff");
    await writeDiff(workspace.path, run.baseSha, postReviewDiff);
    if (!readFileSync(reviewDiff).equals(readFileSync(postReviewDiff))) {
      throw new Error(`Reviewer ${reviewer.id} modified the task workspace`);
    }
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const review = redactJson(parseStructuredOutput<ReviewResult>(resultPath));
    this.assertReviewResult(review);
    run.review = { ...review, reviewerAgentId: reviewer.id };
    if (review.verdict === "fail") {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { type: "review_failed", review }) });
    } else {
      this.setPhase(run, "publish", { attempt: 1 });
    }
  }

  private async phaseRepair(run: Run): Promise<void> {
    if (run.repairCount >= 2) {
      await this.rotateOrEscalate(run, run.error ?? { message: "Repair limit exhausted" });
      return;
    }
    const { task, project, workspace, agent } = this.contextFor(run);
    run.repairCount += 1;
    const feedback = run.error;
    this.saveRun(run);
    const { path } = buildContextEnvelope(this.db, project, task, run, workspace, feedback);
    const schemas = writeSchemas(run.logDir);
    const invocation = adapterFor(agent).invocation({
      kind: "repair",
      prompt: repairPrompt(path),
      workspacePath: workspace.path,
      runDir: run.logDir,
      schemaPath: schemas.worker,
      ...(run.codexSessionId ? { sessionId: run.codexSessionId } : {}),
    });
    const execution = await this.executeInvocation(run, invocation, `repair-${run.repairCount}`, agent.id);
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const result = redactJson(parseStructuredOutput<WorkerResult>(resultPath));
    this.assertWorkerResult(result);
    run.workerResult = result;
    run.workerResultPath = resultPath;
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
      run.baseSha = await branchHead(project.repoPath, projectBaseRef(project));
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
      const targetChanges = await changedPathsBetween(project.repoPath, run.baseSha, targetHead);
      const relevant = changesAffectTask(task, targetChanges);
      try {
        await rebaseOntoTarget(project, workspace.path);
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
      run.baseSha = targetHead;
      this.db.updateWorkspaceBaseline(workspace.id, targetHead);
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
    await waitForRequiredChecks(project, workspace.path, prNumber, 1800, () => this.renewLease(run));
    this.setPhase(run, "merge");
  }

  private async phaseMerge(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    const commitSha = await branchHead(workspace.path, "HEAD");
    const operationId = this.operationId(project.id, task.id, run.id, "merge");
    if (run.effects.merge?.status === "completed" && run.effects.merge.externalRef) {
      if (task.status !== "succeeded") {
        this.db.updateTaskStatus(task.id, "succeeded", {
          summary: run.workerResult?.summary ?? `Completed by run ${run.id}`,
          mergeSha: run.effects.merge.externalRef,
        });
      }
      this.setPhase(run, "cleanup");
      return;
    }
    if (project.deliveryMode === "local") {
      const currentTarget = await branchHead(project.repoPath, project.targetBranch);
      if (currentTarget === commitSha) {
        this.setEffect(run, "merge", { operationId, status: "completed", externalRef: currentTarget });
        if (task.status !== "succeeded") {
          this.db.updateTaskStatus(task.id, "succeeded", { summary: `Completed by run ${run.id}`, mergeSha: currentTarget });
        }
        this.setPhase(run, "cleanup");
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
      this.db.updateTaskStatus(task.id, "succeeded", {
        summary: run.workerResult?.summary ?? `Completed by run ${run.id}`,
        mergeSha,
      });
      this.setPhase(run, "cleanup");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (project.deliveryMode === "local" && message.includes("fast-forward")) {
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

  private async phaseCleanup(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    if (task.status !== "succeeded" && run.effects.merge?.status === "completed" && run.effects.merge.externalRef) {
      this.db.updateTaskStatus(task.id, "succeeded", {
        summary: run.workerResult?.summary ?? `Completed by run ${run.id}`,
        mergeSha: run.effects.merge.externalRef,
      });
    }
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
    return await this.executeCommand(
      run,
      invocation.command,
      label,
      {
        stdin: invocation.stdin,
        structuredOutputPath: invocation.structuredOutputPath,
        agentId,
      },
    );
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
      input = {
        command,
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        resultPath: paths.result,
      };
      if (options.agentId) await this.waitForAgentSlot(options.agentId, run.id, jobId, run);
      try {
        job = startSupervisedJob(input, paths.input, jobId);
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
    const message = redactText(error instanceof Error ? error.message : String(error));
    const operationalRetry = run.error?.operationalRetry;
    run.error = this.failureEvidence(run, {
      phase: run.phase,
      message,
      ...(operationalRetry !== undefined ? { operationalRetry } : {}),
    });
    run.job = undefined;
    if (["execute", "repair"].includes(run.phase)) {
      if (run.attempt < 3) {
        run.attempt += 1;
        run.phase = "execute";
        this.saveRun(run);
        return;
      }
      await this.rotateOrEscalate(run, run.error);
      return;
    }
    if (run.phase === "review" && run.attempt < 3) {
      run.attempt += 1;
      this.saveRun(run);
      return;
    }
    if (run.phase === "remote_checks" && message.startsWith("GitHub checks failed")) {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { phase: run.phase, message }) });
      return;
    }
    const task = this.requireTask(run.taskId);
    if (run.phase === "cleanup" && task.status === "succeeded") {
      run.status = "interrupted";
      run.updatedAt = nowIso();
      run.leaseUntil = undefined;
      run.leaseOwner = undefined;
      this.saveRun(run);
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
      run.rotationCount += 1;
      run.attempt = 1;
      run.repairCount = 0;
      run.agentId = alternate.id;
      run.codexSessionId = undefined;
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
        payload: { agentId: alternate.id, rotationCount: run.rotationCount },
      });
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
    return this.db.transaction(() => {
      const decision = this.db.getDecision(decisionId);
      if (!decision) throw new Error(`Decision not found: ${decisionId}`);
      if (decision.status === "resolved") throw new Error(`Decision is already resolved: ${decisionId}`);
      if (decision.taskId) {
        const action = String(resolution.action ?? "");
        if (action === "retry_with_agent" || action === "resume_task") {
          const run = this.db.getLatestRunForTask(decision.taskId);
          if (run) {
            const task = this.requireTask(decision.taskId);
            if (action === "retry_with_agent") {
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
            run.validation = [];
            run.review = undefined;
            run.job = undefined;
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
      if (task.status === "awaiting_human" && ["resume", "cancel"].includes(input.action)) {
        const pending = this.db.listDecisions(task.projectId, "pending").some((decision) => decision.taskId === task.id);
        if (pending) throw new Error(`Task ${task.id} has an unresolved Human Decision`);
      }
    }
    for (const task of tasks) {
      if (input.action === "pause" && !["succeeded", "failed", "cancelled"].includes(task.status)) {
        this.db.updateTaskStatus(task.id, "paused");
      } else if (input.action === "resume" && ["paused", "operational_blocked", "awaiting_human"].includes(task.status)) {
        this.db.updateTaskStatus(task.id, "ready");
      } else if (input.action === "cancel" && !["succeeded", "failed", "cancelled"].includes(task.status)) {
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
  ): Agent | undefined {
    return this.db
      .listAgents()
      .filter(
        (agent) =>
          agent.enabled &&
          agent.availability === "available" &&
          agent.roles.includes(role) &&
          (loadOverride?.get(agent.id) ?? agent.currentLoad) < agent.maxConcurrency &&
          !excluded.has(agent.id) &&
          capabilities.every((capability) => agent.capabilities.includes(capability)),
      )
      .sort(
        (left, right) =>
          (loadOverride?.get(left.id) ?? left.currentLoad) - (loadOverride?.get(right.id) ?? right.currentLoad) ||
          left.id.localeCompare(right.id),
      )[0];
  }

  private recalculateAgentLoad(): void {
    const jobs = new Map<string, Run>();
    for (const run of this.db.listRuns()) {
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
    const deadline = Date.now() + 60_000;
    let nextHeartbeat = Date.now();
    while (Date.now() < deadline) {
      if (this.db.reserveAgentSlot(agentId, runId, jobId)) return;
      if (Date.now() >= nextHeartbeat) {
        this.renewLease(run);
        nextHeartbeat = Date.now() + 10_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Agent capacity unavailable: ${agentId}`);
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
      throw new Error(`Run lease lost: ${run.id}`);
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
      if (heartbeatError) throw heartbeatError;
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
    if (!this.db.saveRun(run, this.leaseOwner)) throw new Error(`Run lease lost: ${run.id}`);
  }

  private operationId(projectId: string, taskId: string, runId: string, effect: string): string {
    return `${projectId}:${taskId}:${runId}:${effect}`;
  }

  private assertWorkerResult(result: WorkerResult): void {
    if (!result || !["complete", "blocked"].includes(result.status) || typeof result.summary !== "string" || !Array.isArray(result.notes)) {
      throw new Error("Worker returned an invalid structured result");
    }
    if (result.blocker && (
      !["technical", "architecture", "product", "tradeoff"].includes(result.blocker.kind) ||
      typeof result.blocker.question !== "string" ||
      result.blocker.question.length === 0
    )) {
      throw new Error("Worker returned an invalid blocker");
    }
  }

  private assertReviewResult(result: ReviewResult): void {
    if (!result || !["pass", "fail"].includes(result.verdict) || typeof result.summary !== "string" || !Array.isArray(result.findings)) {
      throw new Error("Reviewer returned an invalid structured result");
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
