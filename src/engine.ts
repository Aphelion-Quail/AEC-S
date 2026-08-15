import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  localMerge,
  outOfScopePaths,
  projectBaseRef,
  rebaseInProgress,
  rebaseOntoTarget,
  writeDiff,
} from "./git.js";
import { tasksConflict } from "./glob.js";
import { parseStructuredOutput, readJson, writeJsonAtomic } from "./files.js";
import { startSupervisedJob, waitForJob } from "./job.js";
import { authoritativeCommands, resolveValidationCommand, validationPaths } from "./validation.js";
import { writeSchemas } from "./schemas.js";
import {
  createOrGetPullRequest,
  mergePullRequest,
  pushTaskBranch,
  remoteTaskBranchHead,
  waitForRequiredChecks,
} from "./github.js";

type EngineOptions = {
  globalConcurrency?: number;
};

type JobExecution = {
  result: JobResult;
  stdoutPath: string;
  stderrPath: string;
  structuredOutputPath?: string;
};

const ACTIVE_TASK_STATUSES = new Set(["running"]);

export class AecEngine {
  private readonly globalConcurrency: number;
  private readonly inProcess = new Set<string>();
  private readonly leaseOwner = `${process.pid}:${newId("lease")}`;

  constructor(readonly db: AecDatabase, options: EngineOptions = {}) {
    this.globalConcurrency = options.globalConcurrency ?? 2;
  }

  submitGraph(projectId: string, inputs: TaskInput[]): Task[] {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (inputs.length === 0) throw new Error("Task graph cannot be empty");
    const normalized = inputs.map((input) => ({ ...input, id: input.id ?? newId("task"), projectId }));
    const graphIds = new Set(normalized.map((input) => input.id!));
    if (graphIds.size !== normalized.length) throw new Error("Task graph contains duplicate IDs");
    for (const input of normalized) this.validateTaskInput(input);
    for (const input of normalized) {
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
    this.promoteTasks();
    this.recalculateAgentLoad();
    const allActiveRuns = this.db.listActiveRuns();
    const capacityRuns = allActiveRuns.filter((run) => this.db.getTask(run.taskId)?.status !== "paused");
    const activeRuns = capacityRuns.filter((run) => this.canClaimRun(run));
    const work: Array<Promise<void>> = [];
    for (const run of activeRuns) {
      if (this.inProcess.has(run.taskId)) continue;
      work.push(this.runTask(run.taskId));
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
      work.push(this.runTask(task.id, reservedAgent.id));
    }
    await Promise.all(work);
    return work.length;
  }

  async runUntilIdle(maxCycles = 100): Promise<void> {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      const count = await this.runOnce();
      if (count === 0) return;
    }
    throw new Error(`AEC did not become idle after ${maxCycles} scheduler cycles`);
  }

  async daemon(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const count = await this.runOnce();
      if (count === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async runTask(taskId: string, preferredAgentId?: string): Promise<void> {
    if (this.inProcess.has(taskId)) return;
    this.inProcess.add(taskId);
    try {
      this.promoteTasks();
      let task = this.requireTask(taskId);
      if (["paused", "awaiting_human", "cancelled", "succeeded", "failed"].includes(task.status)) return;
      let run = this.db.getLatestRunForTask(taskId);
      if (run?.status === "interrupted" && task.status === "ready") {
        run.status = "active";
        run.leaseUntil = this.leaseTime();
        run.leaseOwner = undefined;
        this.saveRun(run);
        this.db.updateTaskStatus(task.id, "running");
      } else if (!run || run.status !== "active") {
        run = await this.createRun(task, preferredAgentId);
      }
      if (!run || !this.claimRun(run)) return;
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
    if (project.deliveryMode === "github") await fetchRemote(project);
    const preferred = preferredAgentId ? this.db.getAgent(preferredAgentId) : undefined;
    const agent = preferred ?? this.selectAgent("executor", task.requiredCapabilities);
    if (!agent) throw new Error(`No available executor for task ${task.id}`);
    const baseSha = await branchHead(project.repoPath, projectBaseRef(project));
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
    this.db.updateWorkspaceStatus(workspace.id, "active");
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
    const result = parseStructuredOutput<WorkerResult>(resultPath);
    this.assertWorkerResult(result);
    run.codexSessionId = adapter.extractSessionId(execution.stdoutPath) ?? run.codexSessionId;
    run.error = result.status === "blocked"
      ? this.failureEvidence(run, { workerSummary: result.summary, notes: result.notes })
      : undefined;
    if (result.status === "blocked") {
      this.setPhase(run, "repair");
    } else {
      this.setPhase(run, "validate", { validation: [], review: undefined });
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
    writeFileSync(diffPath, await writeDiff(workspace.path, run.baseSha), { mode: 0o600 });
    run.diffPath = diffPath;
    const commands = authoritativeCommands(project, task, paths);
    for (let index = run.validation.length; index < commands.length; index += 1) {
      const original = commands[index]!;
      const command = resolveValidationCommand(original, workspace.path);
      const name = `${command.program} ${command.args.join(" ")}`.trim();
      const pathsForCommand = validationPaths(run.logDir, index, `${command.program}-${run.attempt}-${run.repairCount}`);
      const execution = await this.executeCommand(run, command, `validation-${index}`, pathsForCommand);
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
    const reviewer = this.selectAgent("reviewer", task.requiredCapabilities, new Set([run.agentId]));
    this.setPhase(run, reviewer ? "review" : "publish");
  }

  private async phaseReview(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    const reviewer = this.selectAgent("reviewer", task.requiredCapabilities, new Set([run.agentId]));
    if (!reviewer) {
      this.setPhase(run, "publish");
      return;
    }
    const { path } = buildContextEnvelope(this.db, project, task, run, workspace);
    const schemas = writeSchemas(run.logDir);
    const invocation = adapterFor(reviewer).invocation({
      kind: "review",
      prompt: reviewPrompt(path, run.diffPath ?? ""),
      workspacePath: workspace.path,
      runDir: run.logDir,
      schemaPath: schemas.review,
    });
    const execution = await this.executeInvocation(run, invocation, "review", reviewer.id);
    const structuredPath = execution.structuredOutputPath ?? invocation.structuredOutputPath;
    const resultPath = existsSync(structuredPath) ? structuredPath : execution.stdoutPath;
    const review = parseStructuredOutput<ReviewResult>(resultPath);
    this.assertReviewResult(review);
    run.review = { ...review, reviewerAgentId: reviewer.id };
    if (review.verdict === "fail") {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { type: "review_failed", review }) });
    } else {
      this.setPhase(run, "publish");
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
    const result = parseStructuredOutput<WorkerResult>(resultPath);
    this.assertWorkerResult(result);
    if (result.status === "blocked") {
      run.error = this.failureEvidence(run, { type: "worker_blocked", summary: result.summary, notes: result.notes });
      this.saveRun(run);
      return;
    }
    if (await rebaseInProgress(workspace.path)) {
      await continueRebase(workspace.path);
      run.baseSha = await branchHead(project.repoPath, projectBaseRef(project));
      run.effects.commit = {
        operationId: this.operationId(project.id, task.id, run.id, "commit"),
        status: "completed",
        externalRef: await branchHead(workspace.path, "HEAD"),
      };
    }
    this.setPhase(run, "validate", { validation: [], review: undefined, error: undefined });
  }

  private async phasePublish(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
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
      run.effects.commit = {
        operationId: this.operationId(project.id, task.id, run.id, "commit"),
        status: "completed",
        externalRef: await branchHead(workspace.path, "HEAD"),
      };
      if (relevant) {
        this.setPhase(run, "validate", { validation: [], review: undefined });
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
    await waitForRequiredChecks(project, workspace.path, prNumber);
    this.setPhase(run, "merge");
  }

  private async phaseMerge(run: Run): Promise<void> {
    const { task, project, workspace } = this.contextFor(run);
    const commitSha = await branchHead(workspace.path, "HEAD");
    const operationId = this.operationId(project.id, task.id, run.id, "merge");
    if (run.effects.merge?.status === "completed" && run.effects.merge.externalRef) {
      this.setPhase(run, "cleanup");
      return;
    }
    this.setEffect(run, "merge", { operationId, status: "started" });
    try {
      let mergeSha: string;
      if (project.deliveryMode === "github") {
        const prRef = run.effects.pullRequest?.externalRef;
        if (!prRef) throw new Error("Cannot merge without a PR reference");
        const prNumber = Number(prRef.split("#").at(-1));
        const merged = await mergePullRequest(workspace.path, prNumber, commitSha);
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
        summary: `Completed by run ${run.id}`,
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
    const { project, workspace } = this.contextFor(run);
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
      if (head === run.effects.commit.externalRef) return;
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
    } else if (run.effects.push?.status !== "completed" || run.effects.push.externalRef !== headSha) {
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
      undefined,
      invocation.stdin,
      invocation.structuredOutputPath,
      agentId,
    );
  }

  private async executeCommand(
    run: Run,
    command: CommandSpec,
    label: string,
    fixedPaths?: { stdout: string; stderr: string; result: string; input: string },
    stdin?: string,
    structuredOutputPath?: string,
    agentId?: string,
  ): Promise<JobExecution> {
    let job = run.job;
    let input: JobInput;
    if (!job) {
      const suffix = newId("job");
      const paths = fixedPaths ?? {
        stdout: join(run.logDir, `${label}-${suffix}.stdout.log`),
        stderr: join(run.logDir, `${label}-${suffix}.stderr.log`),
        result: join(run.logDir, `${label}-${suffix}.result.json`),
        input: join(run.logDir, `${label}-${suffix}.input.json`),
      };
      input = {
        command,
        ...(stdin !== undefined ? { stdin } : {}),
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        resultPath: paths.result,
      };
      job = startSupervisedJob(input, paths.input);
      job.label = label;
      if (structuredOutputPath) job.structuredOutputPath = structuredOutputPath;
      if (agentId) {
        job.agentId = agentId;
        this.adjustAgentLoad(agentId, 1);
      }
      run.job = job;
      this.saveRun(run);
    } else {
      input = readJson<JobInput>(job.inputPath);
    }
    let result: JobResult;
    try {
      result = await waitForJob(job, command.timeoutSeconds ?? 300);
    } catch (error) {
      if (job.agentId) this.adjustAgentLoad(job.agentId, -1);
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
    if (job.agentId) this.adjustAgentLoad(job.agentId, -1);
    this.saveRun(run);
    if (result.status !== "completed" || result.exitCode !== 0) {
      const stderr = existsSync(input.stderrPath) ? readFileSync(input.stderrPath, "utf8").trim() : "";
      throw new Error(`${label} failed (${result.status}, exit ${String(result.exitCode)}): ${stderr.slice(-4000)}`);
    }
    return execution;
  }

  private async handlePhaseError(run: Run, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    run.error = this.failureEvidence(run, { phase: run.phase, message });
    run.job = undefined;
    if (["execute", "repair", "review"].includes(run.phase)) {
      if (run.attempt < 3) {
        run.attempt += 1;
        run.phase = run.phase === "review" ? "repair" : "execute";
        this.saveRun(run);
        return;
      }
      await this.rotateOrEscalate(run, run.error);
      return;
    }
    if (run.phase === "remote_checks" && message.startsWith("GitHub checks failed")) {
      this.setPhase(run, "repair", { error: this.failureEvidence(run, { phase: run.phase, message }) });
      return;
    }
    run.status = "interrupted";
    run.updatedAt = nowIso();
    run.leaseUntil = undefined;
    run.leaseOwner = undefined;
    this.saveRun(run);
    this.db.updateTaskStatus(run.taskId, "operational_blocked", { summary: message });
    const workspace = this.db.getWorkspace(run.workspaceId);
    if (workspace) this.db.updateWorkspaceStatus(workspace.id, "preserved");
    this.db.appendEvent({
      taskId: run.taskId,
      runId: run.id,
      type: "run.operational_blocked",
      payload: { phase: run.phase, message },
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
    const decision = this.db.createDecision({
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
  }

  resolveDecision(decisionId: string, resolution: JsonObject): Decision {
    const decision = this.db.resolveDecision(decisionId, resolution);
    if (decision.taskId) {
      const action = String(resolution.action ?? "");
      if (action === "retry_with_agent") {
        const run = this.db.getLatestRunForTask(decision.taskId);
        if (run) {
          run.status = "active";
          run.phase = "execute";
          run.attempt = 1;
          run.repairCount = 0;
          run.rotationCount = 0;
          run.error = { humanResolution: resolution };
          run.leaseUntil = this.leaseTime();
          run.leaseOwner = undefined;
          this.saveRun(run);
        }
        this.db.updateTaskStatus(decision.taskId, "ready");
      }
      else if (action === "cancel_task") this.db.updateTaskStatus(decision.taskId, "cancelled", { summary: "Cancelled by Human decision" });
    }
    return decision;
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
        this.db.db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?").run(input.priority, nowIso(), task.id);
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
    const counts = new Map<string, number>();
    for (const run of this.db.listActiveRuns()) {
      if (run.job?.agentId) counts.set(run.job.agentId, (counts.get(run.job.agentId) ?? 0) + 1);
    }
    for (const agent of this.db.listAgents()) this.db.setAgentLoad(agent.id, counts.get(agent.id) ?? 0);
  }

  private adjustAgentLoad(agentId: string, delta: number): void {
    const agent = this.db.getAgent(agentId);
    if (agent) this.db.setAgentLoad(agentId, Math.max(0, agent.currentLoad + delta));
  }

  private failureEvidence(run: Run, value: JsonObject): JsonObject {
    const agentHistory = Array.isArray(run.error?.agentHistory) ? run.error.agentHistory : [];
    return { ...value, agentHistory };
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
    run.leaseUntil = this.leaseTime();
    run.leaseOwner = this.leaseOwner;
    run.updatedAt = nowIso();
    this.saveRun(run);
  }

  private leaseTime(): string {
    return new Date(Date.now() + 90_000).toISOString();
  }

  private canClaimRun(run: Run): boolean {
    if (!run.leaseOwner || run.leaseOwner === this.leaseOwner) return true;
    const ownerPid = Number(run.leaseOwner.split(":", 1)[0]);
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        return false;
      } catch {
        return true;
      }
    }
    return !run.leaseUntil || Date.parse(run.leaseUntil) <= Date.now();
  }

  private claimRun(run: Run): boolean {
    if (!this.canClaimRun(run)) return false;
    const claimed = this.db.claimRun(run.id, run.leaseOwner, this.leaseOwner, this.leaseTime());
    if (claimed) run.leaseOwner = this.leaseOwner;
    return claimed;
  }

  private saveRun(run: Run): void {
    run.updatedAt = nowIso();
    this.db.saveRun(run);
  }

  private operationId(projectId: string, taskId: string, runId: string, effect: string): string {
    return `${projectId}:${taskId}:${runId}:${effect}`;
  }

  private assertWorkerResult(result: WorkerResult): void {
    if (!result || !["complete", "blocked"].includes(result.status) || typeof result.summary !== "string" || !Array.isArray(result.notes)) {
      throw new Error("Worker returned an invalid structured result");
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
