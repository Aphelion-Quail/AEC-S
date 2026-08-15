import { DatabaseSync } from "node:sqlite";
import type {
  Agent,
  AgentInput,
  AgentUpdate,
  Decision,
  DecisionInput,
  EventRecord,
  JsonObject,
  Project,
  ProjectInput,
  ProjectUpdate,
  Run,
  Task,
  TaskInput,
  TaskStatus,
  Workspace,
  WorkspaceStatus,
} from "./types.js";
import { agentInputSchema, decisionInputSchema, projectInputSchema, taskInputSchema } from "./input.js";
import { newId, nowIso } from "./ids.js";
import { ensureAecPaths, getAecPaths, type AecPaths } from "./paths.js";

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | Uint8Array | null;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return JSON.parse(value) as T;
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

export class AecDatabase {
  readonly paths: AecPaths;
  readonly db: DatabaseSync;

  constructor(home?: string) {
    this.paths = getAecPaths(home);
    ensureAecPaths(this.paths);
    this.db = new DatabaseSync(this.paths.database);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private transactionDepth = 0;

  transaction<T>(fn: () => T): T {
    const outermost = this.transactionDepth === 0;
    const savepoint = `aec_nested_${this.transactionDepth}`;
    if (outermost) this.db.exec("BEGIN IMMEDIATE");
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const value = fn();
      if (outermost) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      if (outermost) this.db.exec("ROLLBACK");
      else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private migrate(): void {
    const currentVersion = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    const latestVersion = 4;
    if (currentVersion > latestVersion) {
      throw new Error(`AEC database schema ${currentVersion} is newer than supported schema ${latestVersion}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL UNIQUE,
        target_branch TEXT NOT NULL,
        remote_name TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        intent TEXT NOT NULL,
        default_validation_json TEXT NOT NULL,
        full_validation_json TEXT NOT NULL,
        required_checks_json TEXT NOT NULL,
        high_risk_globs_json TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        required_caps_json TEXT NOT NULL,
        requires_full INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        replaces_task_id TEXT REFERENCES tasks(id),
        decision_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        terminal_summary TEXT,
        merge_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapter TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        availability TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL,
        current_load INTEGER NOT NULL,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        workspace_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        repair_count INTEGER NOT NULL,
        rotation_count INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        codex_session_id TEXT,
        worker_result_json TEXT,
        worker_result_path TEXT,
        validation_json TEXT NOT NULL,
        review_json TEXT,
        effects_json TEXT NOT NULL,
        job_json TEXT,
        log_dir TEXT NOT NULL,
        diff_path TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_until TEXT,
        lease_owner TEXT
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        task_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT REFERENCES tasks(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        options_json TEXT NOT NULL,
        resolution_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_leases (
        job_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, lease_until);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_decisions_project_status ON decisions(project_id, status);
    `);
    const runColumns = this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "lease_owner")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN lease_owner TEXT");
    }
    if (!runColumns.some((column) => column.name === "worker_result_json")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN worker_result_json TEXT");
    }
    if (!runColumns.some((column) => column.name === "worker_result_path")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN worker_result_path TEXT");
    }
    const appliedAt = nowIso();
    const migration = this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)");
    for (let version = currentVersion + 1; version <= latestVersion; version += 1) migration.run(version, appliedAt);
    this.db.exec(`PRAGMA user_version = ${latestVersion}`);
  }

  createProject(input: ProjectInput): Project {
    input = projectInputSchema.parse(input) as ProjectInput;
    const project: Project = {
      id: input.id ?? newId("project"),
      name: input.name,
      repoPath: input.repoPath,
      targetBranch: input.targetBranch ?? "main",
      remoteName: input.remoteName ?? "origin",
      deliveryMode: input.deliveryMode ?? "local",
      intent: input.intent ?? "",
      defaultValidation: input.defaultValidation ?? [],
      fullValidation: input.fullValidation ?? [],
      requiredChecks: input.requiredChecks ?? [],
      highRiskGlobs: input.highRiskGlobs ?? [],
      maxConcurrency: input.maxConcurrency ?? 2,
      createdAt: nowIso(),
    };
    this.db
      .prepare(`INSERT INTO projects(
        id, name, repo_path, target_branch, remote_name, delivery_mode, intent,
        default_validation_json, full_validation_json, required_checks_json,
        high_risk_globs_json, max_concurrency, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        project.id,
        project.name,
        project.repoPath,
        project.targetBranch,
        project.remoteName,
        project.deliveryMode,
        project.intent,
        JSON.stringify(project.defaultValidation),
        JSON.stringify(project.fullValidation),
        JSON.stringify(project.requiredChecks),
        JSON.stringify(project.highRiskGlobs),
        project.maxConcurrency,
        project.createdAt,
      );
    this.appendEvent({ projectId: project.id, type: "project.created", payload: { name: project.name } });
    return project;
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? this.projectFromRow(row) : undefined;
  }

  getProjectByName(name: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as Row | undefined;
    return row ? this.projectFromRow(row) : undefined;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map((row) =>
      this.projectFromRow(row),
    );
  }

  updateProject(id: string, patch: ProjectUpdate): Project {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    const { createdAt: _createdAt, ...currentInput } = current;
    const next = projectInputSchema.parse({ ...currentInput, ...patch, id, name: current.name, repoPath: current.repoPath }) as ProjectInput;
    this.db.prepare(`UPDATE projects SET target_branch=?, remote_name=?, delivery_mode=?, intent=?,
      default_validation_json=?, full_validation_json=?, required_checks_json=?, high_risk_globs_json=?, max_concurrency=? WHERE id=?`)
      .run(
        next.targetBranch ?? current.targetBranch,
        next.remoteName ?? current.remoteName,
        next.deliveryMode ?? current.deliveryMode,
        next.intent ?? current.intent,
        JSON.stringify(next.defaultValidation ?? current.defaultValidation),
        JSON.stringify(next.fullValidation ?? current.fullValidation),
        JSON.stringify(next.requiredChecks ?? current.requiredChecks),
        JSON.stringify(next.highRiskGlobs ?? current.highRiskGlobs),
        next.maxConcurrency ?? current.maxConcurrency,
        id,
      );
    this.appendEvent({ projectId: id, type: "project.updated", payload: { fields: Object.keys(patch) } });
    return this.getProject(id)!;
  }

  private projectFromRow(row: Row): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      repoPath: String(row.repo_path),
      targetBranch: String(row.target_branch),
      remoteName: String(row.remote_name),
      deliveryMode: String(row.delivery_mode) as Project["deliveryMode"],
      intent: String(row.intent),
      defaultValidation: json(row.default_validation_json, []),
      fullValidation: json(row.full_validation_json, []),
      requiredChecks: json(row.required_checks_json, []),
      highRiskGlobs: json(row.high_risk_globs_json, []),
      maxConcurrency: Number(row.max_concurrency),
      createdAt: String(row.created_at),
    };
  }

  createTask(input: TaskInput): Task {
    input = taskInputSchema.parse(input) as TaskInput;
    const timestamp = nowIso();
    const task: Task = {
      id: input.id ?? newId("task"),
      projectId: input.projectId,
      title: input.title,
      goal: input.goal,
      scope: input.scope,
      dependsOn: input.dependsOn ?? [],
      constraints: input.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria,
      validationCommands: input.validationCommands ?? [],
      requiredCapabilities: input.requiredCapabilities ?? [],
      requiresFullValidation: input.requiresFullValidation ?? false,
      priority: input.priority ?? 0,
      ...(input.replacesTaskId ? { replacesTaskId: input.replacesTaskId } : {}),
      decisionIds: input.decisionIds ?? [],
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(`INSERT INTO tasks (
        id, project_id, title, goal, scope_json, depends_on_json, constraints_json,
        acceptance_json, validation_json, required_caps_json, requires_full, priority,
        replaces_task_id, decision_ids_json, status, terminal_summary, merge_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
      .run(
        task.id,
        task.projectId,
        task.title,
        task.goal,
        JSON.stringify(task.scope),
        JSON.stringify(task.dependsOn),
        JSON.stringify(task.constraints),
        JSON.stringify(task.acceptanceCriteria),
        JSON.stringify(task.validationCommands),
        JSON.stringify(task.requiredCapabilities),
        task.requiresFullValidation ? 1 : 0,
        task.priority,
        task.replacesTaskId ?? null,
        JSON.stringify(task.decisionIds),
        task.status,
        task.createdAt,
        task.updatedAt,
      );
    this.appendEvent({
      projectId: task.projectId,
      taskId: task.id,
      type: "task.created",
      payload: { title: task.title },
    });
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  listTasks(projectId?: string): Task[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at").all() as Row[]);
    return rows.map((row) => this.taskFromRow(row));
  }

  listRunnableTasks(): Task[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE status IN ('queued', 'ready', 'operational_blocked') ORDER BY priority DESC, created_at, id")
        .all() as Row[]
    ).map((row) => this.taskFromRow(row));
  }

  updateTaskStatus(id: string, status: TaskStatus, extra?: { summary?: string | null; mergeSha?: string | null }): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const updatedAt = nowIso();
    const summary = extra && Object.hasOwn(extra, "summary") ? extra.summary ?? null : task.terminalSummary ?? null;
    const mergeSha = extra && Object.hasOwn(extra, "mergeSha") ? extra.mergeSha ?? null : task.mergeSha ?? null;
    this.db
      .prepare("UPDATE tasks SET status = ?, terminal_summary = ?, merge_sha = ?, updated_at = ? WHERE id = ?")
      .run(status, summary, mergeSha, updatedAt, id);
    this.appendEvent({
      projectId: task.projectId,
      taskId: id,
      type: "task.status_changed",
      payload: { from: task.status, to: status },
    });
  }

  private taskFromRow(row: Row): Task {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      goal: String(row.goal),
      scope: json(row.scope_json, { writeGlobs: [], impactGlobs: [], tags: [] }),
      dependsOn: json(row.depends_on_json, []),
      constraints: json(row.constraints_json, []),
      acceptanceCriteria: json(row.acceptance_json, []),
      validationCommands: json(row.validation_json, []),
      requiredCapabilities: json(row.required_caps_json, []),
      requiresFullValidation: bool(row.requires_full),
      priority: Number(row.priority),
      ...(row.replaces_task_id ? { replacesTaskId: String(row.replaces_task_id) } : {}),
      decisionIds: json(row.decision_ids_json, []),
      status: String(row.status) as TaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.terminal_summary ? { terminalSummary: String(row.terminal_summary) } : {}),
      ...(row.merge_sha ? { mergeSha: String(row.merge_sha) } : {}),
    };
  }

  createAgent(input: AgentInput): Agent {
    input = agentInputSchema.parse(input) as AgentInput;
    const agent: Agent = {
      id: input.id ?? newId("agent"),
      name: input.name,
      adapter: input.adapter,
      roles: input.roles,
      capabilities: input.capabilities ?? [],
      enabled: input.enabled ?? true,
      availability: input.availability ?? "available",
      maxConcurrency: input.maxConcurrency ?? 1,
      currentLoad: 0,
      config: input.config ?? {},
    };
    this.db
      .prepare(`INSERT INTO agents(
        id, name, adapter, roles_json, capabilities_json, enabled, availability,
        max_concurrency, current_load, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        agent.id,
        agent.name,
        agent.adapter,
        JSON.stringify(agent.roles),
        JSON.stringify(agent.capabilities),
        agent.enabled ? 1 : 0,
        agent.availability,
        agent.maxConcurrency,
        agent.currentLoad,
        JSON.stringify(agent.config),
      );
    this.appendEvent({ type: "agent.created", payload: { agentId: agent.id, name: agent.name } });
    return agent;
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? this.agentFromRow(row) : undefined;
  }

  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY name, id").all() as Row[]).map((row) => this.agentFromRow(row));
  }

  updateAgent(id: string, patch: AgentUpdate): Agent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    const { currentLoad: _currentLoad, ...currentInput } = current;
    const next = agentInputSchema.parse({ ...currentInput, ...patch, id, name: current.name, adapter: current.adapter }) as AgentInput;
    this.db.prepare(`UPDATE agents SET roles_json=?, capabilities_json=?, enabled=?, availability=?,
      max_concurrency=?, config_json=? WHERE id=?`)
      .run(
        JSON.stringify(next.roles ?? current.roles),
        JSON.stringify(next.capabilities ?? current.capabilities),
        (next.enabled ?? current.enabled) ? 1 : 0,
        next.availability ?? current.availability,
        next.maxConcurrency ?? current.maxConcurrency,
        JSON.stringify(next.config ?? current.config),
        id,
      );
    this.appendEvent({ type: "agent.updated", payload: { agentId: id, fields: Object.keys(patch) } });
    return this.getAgent(id)!;
  }

  reserveAgentSlot(agentId: string, runId: string, jobId: string): boolean {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (!agent || !agent.enabled || agent.availability !== "available") return false;
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM agent_leases WHERE agent_id=?").get(agentId) as Row).count);
      if (count >= agent.maxConcurrency) return false;
      const result = this.db.prepare("INSERT OR IGNORE INTO agent_leases(job_id, agent_id, run_id, created_at) VALUES (?, ?, ?, ?)")
        .run(jobId, agentId, runId, nowIso());
      this.db.prepare("UPDATE agents SET current_load=(SELECT COUNT(*) FROM agent_leases WHERE agent_id=?) WHERE id=?")
        .run(agentId, agentId);
      return result.changes === 1;
    });
  }

  ensureAgentSlot(agentId: string, runId: string, jobId: string): void {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO agent_leases(job_id, agent_id, run_id, created_at) VALUES (?, ?, ?, ?)")
        .run(jobId, agentId, runId, nowIso());
      this.db.prepare("UPDATE agents SET current_load=(SELECT COUNT(*) FROM agent_leases WHERE agent_id=?) WHERE id=?")
        .run(agentId, agentId);
    });
  }

  releaseAgentSlot(jobId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT agent_id FROM agent_leases WHERE job_id=?").get(jobId) as Row | undefined;
      this.db.prepare("DELETE FROM agent_leases WHERE job_id=?").run(jobId);
      if (row) {
        const agentId = String(row.agent_id);
        this.db.prepare("UPDATE agents SET current_load=(SELECT COUNT(*) FROM agent_leases WHERE agent_id=?) WHERE id=?")
          .run(agentId, agentId);
      }
    });
  }

  listAgentLeases(): Array<{ jobId: string; agentId: string; runId: string; createdAt: string }> {
    return (this.db.prepare("SELECT * FROM agent_leases ORDER BY created_at").all() as Row[]).map((row) => ({
      jobId: String(row.job_id),
      agentId: String(row.agent_id),
      runId: String(row.run_id),
      createdAt: String(row.created_at),
    }));
  }

  private agentFromRow(row: Row): Agent {
    return {
      id: String(row.id),
      name: String(row.name),
      adapter: String(row.adapter) as Agent["adapter"],
      roles: json(row.roles_json, []),
      capabilities: json(row.capabilities_json, []),
      enabled: bool(row.enabled),
      availability: String(row.availability) as Agent["availability"],
      maxConcurrency: Number(row.max_concurrency),
      currentLoad: Number(row.current_load),
      config: json(row.config_json, {}),
    };
  }

  createRun(run: Run): Run {
    this.db
      .prepare(`INSERT INTO runs (
        id, task_id, agent_id, workspace_id, phase, status, attempt, repair_count,
        rotation_count, base_sha, codex_session_id, worker_result_json, worker_result_path, validation_json, review_json,
        effects_json, job_json, log_dir, diff_path, error_json, started_at, updated_at, lease_until, lease_owner
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...this.runValues(run));
    const task = this.getTask(run.taskId);
    this.appendEvent({
      projectId: task?.projectId,
      taskId: run.taskId,
      runId: run.id,
      type: "run.created",
      payload: { attempt: run.attempt, agentId: run.agentId },
    });
    return run;
  }

  saveRun(run: Run, expectedOwner = run.leaseOwner): boolean {
    const values = this.runValues(run);
    const result = this.db
      .prepare(`UPDATE runs SET
        task_id=?, agent_id=?, workspace_id=?, phase=?, status=?, attempt=?, repair_count=?,
        rotation_count=?, base_sha=?, codex_session_id=?, worker_result_json=?, worker_result_path=?, validation_json=?, review_json=?,
        effects_json=?, job_json=?, log_dir=?, diff_path=?, error_json=?, started_at=?, updated_at=?, lease_until=?, lease_owner=?
        WHERE id=? AND lease_owner IS ?`)
      .run(...values.slice(1), run.id, expectedOwner ?? null);
    return result.changes === 1;
  }

  resumeInterruptedRun(id: string, owner: string, leaseUntil: string): boolean {
    const result = this.db
      .prepare(`UPDATE runs SET status='active', lease_owner=?, lease_until=?, updated_at=?
        WHERE id=? AND status='interrupted' AND lease_owner IS NULL`)
      .run(owner, leaseUntil, nowIso(), id);
    return result.changes === 1;
  }

  private runValues(run: Run): SqlValue[] {
    return [
      run.id,
      run.taskId,
      run.agentId,
      run.workspaceId,
      run.phase,
      run.status,
      run.attempt,
      run.repairCount,
      run.rotationCount,
      run.baseSha,
      run.codexSessionId ?? null,
      run.workerResult ? JSON.stringify(run.workerResult) : null,
      run.workerResultPath ?? null,
      JSON.stringify(run.validation),
      run.review ? JSON.stringify(run.review) : null,
      JSON.stringify(run.effects),
      run.job ? JSON.stringify(run.job) : null,
      run.logDir,
      run.diffPath ?? null,
      run.error ? JSON.stringify(run.error) : null,
      run.startedAt,
      run.updatedAt,
      run.leaseUntil ?? null,
      run.leaseOwner ?? null,
    ];
  }

  claimRun(id: string, expectedOwner: string | undefined, owner: string, leaseUntil: string): boolean {
    const result = this.db
      .prepare(`UPDATE runs SET lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND lease_owner IS ?`)
      .run(owner, leaseUntil, nowIso(), id, expectedOwner ?? null);
    return result.changes === 1;
  }

  renewRunLease(id: string, owner: string, leaseUntil: string): boolean {
    const result = this.db
      .prepare("UPDATE runs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'active' AND lease_owner = ?")
      .run(leaseUntil, nowIso(), id, owner);
    return result.changes === 1;
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  getLatestRunForTask(taskId: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").get(taskId) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listRuns(taskId?: string): Run[] {
    const rows = taskId
      ? (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId) as Row[])
      : (this.db.prepare("SELECT * FROM runs ORDER BY started_at").all() as Row[]);
    return rows.map((row) => this.runFromRow(row));
  }

  listLatestRuns(projectId?: string): Run[] {
    const sql = `SELECT runs.* FROM runs
      JOIN tasks ON tasks.id = runs.task_id
      WHERE runs.id = (
        SELECT candidate.id FROM runs AS candidate
        WHERE candidate.task_id = runs.task_id
        ORDER BY candidate.started_at DESC, candidate.rowid DESC LIMIT 1
      )${projectId ? " AND tasks.project_id = ?" : ""}
      ORDER BY runs.started_at`;
    const rows = projectId
      ? this.db.prepare(sql).all(projectId) as Row[]
      : this.db.prepare(sql).all() as Row[];
    return rows.map((row) => this.runFromRow(row));
  }

  listActiveRuns(): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = 'active' OR (status = 'interrupted' AND phase = 'cleanup') ORDER BY started_at").all() as Row[]).map((row) =>
      this.runFromRow(row),
    );
  }

  private runFromRow(row: Row): Run {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      agentId: String(row.agent_id),
      workspaceId: String(row.workspace_id),
      phase: String(row.phase) as Run["phase"],
      status: String(row.status) as Run["status"],
      attempt: Number(row.attempt),
      repairCount: Number(row.repair_count),
      rotationCount: Number(row.rotation_count),
      baseSha: String(row.base_sha),
      ...(row.codex_session_id ? { codexSessionId: String(row.codex_session_id) } : {}),
      ...(row.worker_result_json ? { workerResult: json(row.worker_result_json, undefined) } : {}),
      ...(row.worker_result_path ? { workerResultPath: String(row.worker_result_path) } : {}),
      validation: json(row.validation_json, []),
      ...(row.review_json ? { review: json(row.review_json, undefined) } : {}),
      effects: json(row.effects_json, {}),
      ...(row.job_json ? { job: json(row.job_json, undefined) } : {}),
      logDir: String(row.log_dir),
      ...(row.diff_path ? { diffPath: String(row.diff_path) } : {}),
      ...(row.error_json ? { error: json(row.error_json, {}) } : {}),
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      ...(row.lease_until ? { leaseUntil: String(row.lease_until) } : {}),
      ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    };
  }

  createWorkspace(workspace: Workspace): Workspace {
    this.db
      .prepare(`INSERT INTO workspaces(
        id, project_id, task_id, run_id, path, branch, base_sha, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        workspace.id,
        workspace.projectId,
        workspace.taskId,
        workspace.runId,
        workspace.path,
        workspace.branch,
        workspace.baseSha,
        workspace.status,
        workspace.createdAt,
        workspace.updatedAt,
      );
    return workspace;
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      path: String(row.path),
      branch: String(row.branch),
      baseSha: String(row.base_sha),
      status: String(row.status) as WorkspaceStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listWorkspaces(projectId?: string): Workspace[] {
    const rows = projectId
      ? (this.db.prepare("SELECT id FROM workspaces WHERE project_id = ? ORDER BY created_at").all(projectId) as Row[])
      : (this.db.prepare("SELECT id FROM workspaces ORDER BY created_at").all() as Row[]);
    return rows.map((row) => this.getWorkspace(String(row.id))!);
  }

  updateWorkspaceStatus(id: string, status: WorkspaceStatus): void {
    this.db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  }

  createDecision(input: DecisionInput): Decision {
    input = decisionInputSchema.parse(input) as DecisionInput;
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    if (input.taskId) {
      const task = this.getTask(input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      if (task.projectId !== input.projectId) throw new Error("Decision Task must belong to the same Project");
    }
    const decision: Decision = {
      id: input.id ?? newId("decision"),
      projectId: input.projectId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind: input.kind,
      status: input.status ?? "pending",
      title: input.title,
      body: input.body,
      options: input.options ?? [],
      ...(input.resolution ? { resolution: input.resolution } : {}),
      createdAt: nowIso(),
      ...(input.status === "resolved" ? { resolvedAt: nowIso() } : {}),
    };
    this.db
      .prepare(`INSERT INTO decisions(
        id, project_id, task_id, kind, status, title, body, options_json,
        resolution_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        decision.id,
        decision.projectId,
        decision.taskId ?? null,
        decision.kind,
        decision.status,
        decision.title,
        decision.body,
        JSON.stringify(decision.options),
        decision.resolution ? JSON.stringify(decision.resolution) : null,
        decision.createdAt,
        decision.resolvedAt ?? null,
      );
    this.appendEvent({
      projectId: decision.projectId,
      taskId: decision.taskId,
      type: "decision.created",
      payload: { decisionId: decision.id, kind: decision.kind },
    });
    return decision;
  }

  listDecisions(projectId?: string, status?: Decision["status"]): Decision[] {
    let sql = "SELECT * FROM decisions";
    const args: string[] = [];
    const where: string[] = [];
    if (projectId) {
      where.push("project_id = ?");
      args.push(projectId);
    }
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at";
    return (this.db.prepare(sql).all(...args) as Row[]).map((row) => this.decisionFromRow(row));
  }

  getDecision(id: string): Decision | undefined {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.decisionFromRow(row) : undefined;
  }

  resolveDecision(id: string, resolution: JsonObject): Decision {
    const decision = this.getDecision(id);
    if (!decision) throw new Error(`Decision not found: ${id}`);
    if (decision.status === "resolved") throw new Error(`Decision is already resolved: ${id}`);
    const resolvedAt = nowIso();
    const result = this.db
      .prepare("UPDATE decisions SET status = 'resolved', resolution_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(JSON.stringify(resolution), resolvedAt, id);
    if (result.changes !== 1) throw new Error(`Decision is already resolved: ${id}`);
    this.appendEvent({
      projectId: decision.projectId,
      taskId: decision.taskId,
      type: "decision.resolved",
      payload: { decisionId: id },
    });
    return this.getDecision(id)!;
  }

  private decisionFromRow(row: Row): Decision {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      kind: String(row.kind) as Decision["kind"],
      status: String(row.status) as Decision["status"],
      title: String(row.title),
      body: String(row.body),
      options: json(row.options_json, []),
      ...(row.resolution_json ? { resolution: json(row.resolution_json, {}) } : {}),
      createdAt: String(row.created_at),
      ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
    };
  }

  appendEvent(input: {
    projectId?: string;
    taskId?: string;
    runId?: string;
    type: string;
    payload?: JsonObject;
  }): number {
    const result = this.db
      .prepare("INSERT INTO events(project_id, task_id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        input.projectId ?? null,
        input.taskId ?? null,
        input.runId ?? null,
        input.type,
        JSON.stringify(input.payload ?? {}),
        nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  listEvents(projectId?: string, limit = 100): EventRecord[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as Row[])
      : (this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Row[]);
    return rows.map((row) => ({
      id: Number(row.id),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
      type: String(row.type),
      payload: json(row.payload_json, {}),
      createdAt: String(row.created_at),
    }));
  }

  pruneEvents(retain = 50_000): number {
    const result = this.db.prepare(`DELETE FROM events WHERE id < COALESCE(
      (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?), 0
    )`).run(Math.max(0, retain - 1));
    return Number(result.changes);
  }

  statusSnapshot(projectId?: string): JsonObject {
    const projects = projectId ? [this.getProject(projectId)].filter(Boolean) : this.listProjects();
    const tasks = this.listTasks(projectId);
    const runs = this.listLatestRuns(projectId);
    return {
      projects,
      tasks,
      runs,
      agents: this.listAgents(),
      workspaces: this.listWorkspaces(projectId),
      decisions: this.listDecisions(projectId),
      events: this.listEvents(projectId),
    };
  }
}
