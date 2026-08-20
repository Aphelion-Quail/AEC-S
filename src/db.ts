import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  Agent,
  AgentInput,
  AgentUpdate,
  Decision,
  DecisionInput,
  EventRecord,
  Finding,
  FindingStatus,
  JsonObject,
  OutboxMessage,
  Project,
  ProjectInput,
  ProjectUpdate,
  Run,
  Task,
  TaskInput,
  TaskRevision,
  TaskStatus,
  Workspace,
  WorkspaceStatus,
} from "./types.js";
import { agentInputSchema, decisionInputSchema, projectInputSchema, taskInputSchema, taskScopeSchema } from "./input.js";
import { newId, nowIso } from "./ids.js";
import { fingerprint } from "./fingerprint.js";
import { globsMayOverlap } from "./glob.js";
import { ensureAecSPaths, getAecSPaths, type AecSPaths } from "./paths.js";
import { isSecretKey, redactJson, redactText } from "./redaction.js";

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | Uint8Array | null;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return JSON.parse(value) as T;
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function assertNoPersistedSecrets(value: unknown, location: string, rejectEnvironmentMaps = false): void {
  if (typeof value === "string") {
    if (redactText(value, Number.MAX_SAFE_INTEGER) !== value) throw new Error(`${location} contains secret-like material and cannot be persisted`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoPersistedSecrets(child, `${location}[${index}]`, rejectEnvironmentMaps));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key) ||
        (rejectEnvironmentMaps && /^(?:env|environment)$/i.test(key))) {
      throw new Error(`${location}.${key} is secret-bearing configuration and cannot be persisted`);
    }
    assertNoPersistedSecrets(child, `${location}.${key}`, rejectEnvironmentMaps);
  }
}

function normalizeStoredScope(value: unknown): Task["scope"] {
  const scope = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    writeGlobs: Array.isArray(scope.writeGlobs) ? scope.writeGlobs.map(String) : [],
    watchGlobs: Array.isArray(scope.watchGlobs)
      ? scope.watchGlobs.map(String)
      : Array.isArray(scope.impactGlobs) ? scope.impactGlobs.map(String) : [],
    tags: Array.isArray(scope.tags) ? scope.tags.map(String) : [],
  };
}

const DEFAULT_OPERATIONAL_CONFIG = {
  healthFailureThreshold: 3,
  healthRecoveryThreshold: 2,
  healthProbeIntervalSeconds: 60,
  stabilityObservationSeconds: 0,
  networkPolicy: { mode: "brokered" as const, dependencyHosts: [] as string[] },
};

const DEFAULT_CONTROL_POLICY = {
  version: 1,
  scopeCalibration: "observe" as const,
  temporaryRiskElevation: "observe" as const,
  progressiveDagParking: "observe" as const,
  autoRevert: "observe" as const,
  circuitBreaker: "observe" as const,
  strictReviewMinRuntimeFamilies: 1,
};

export class AecSDatabase {
  readonly paths: AecSPaths;
  readonly db: DatabaseSync;

  constructor(home?: string, options: { allowLegacyMigration?: boolean } = {}) {
    this.paths = getAecSPaths(home);
    ensureAecSPaths(this.paths);
    this.db = new DatabaseSync(this.paths.database);
    chmodSync(this.paths.database, 0o600);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate(options.allowLegacyMigration ?? false);
    this.secureDatabaseFiles();
  }

  close(): void {
    this.db.close();
  }

  private transactionDepth = 0;

  transaction<T>(fn: () => T): T {
    const outermost = this.transactionDepth === 0;
    const savepoint = `aec_s_nested_${this.transactionDepth}`;
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
      if (outermost) this.secureDatabaseFiles();
    }
  }

  private secureDatabaseFiles(): void {
    for (const path of [this.paths.database, `${this.paths.database}-wal`, `${this.paths.database}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  private migrate(allowLegacyMigration: boolean): void {
    const currentVersion = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    const latestVersion = 9;
    if (currentVersion > latestVersion) {
      throw new Error(`AEC-S database schema ${currentVersion} is newer than supported schema ${latestVersion}`);
    }
    if (currentVersion > 0 && currentVersion < 5 && !allowLegacyMigration) {
      throw new Error(`AEC-S pre-1.0 state schema ${currentVersion} must be atomically archived with 'aec-s init'; automatic import is disabled`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    if (currentVersion === latestVersion) return;

    this.transaction(() => {
      for (let version = currentVersion + 1; version <= latestVersion; version += 1) {
        this.applyMigration(version);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, nowIso());
        this.db.exec(`PRAGMA user_version = ${version}`);
      }
    });
  }

  private applyMigration(version: number): void {
    if (version === 1) {
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
        validation_json TEXT NOT NULL,
        review_json TEXT,
        effects_json TEXT NOT NULL,
        job_json TEXT,
        log_dir TEXT NOT NULL,
        diff_path TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_until TEXT
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

      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, lease_until);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_decisions_project_status ON decisions(project_id, status);
      `);
      return;
    }
    if (version === 2) {
      if (!this.tableHasColumn("runs", "lease_owner")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN lease_owner TEXT");
      }
      return;
    }
    if (version === 3) {
      if (!this.tableHasColumn("runs", "worker_result_json")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN worker_result_json TEXT");
      }
      if (!this.tableHasColumn("runs", "worker_result_path")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN worker_result_path TEXT");
      }
      return;
    }
    if (version === 4) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_leases (
        job_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      )`);
      return;
    }
    if (version === 5) {
      for (const [table, column, definition] of [
        ["projects", "intent_version", "INTEGER NOT NULL DEFAULT 1"],
        ["projects", "environment_contract_json", "TEXT NOT NULL DEFAULT '{\"version\":1,\"components\":[]}'"],
        ["projects", "operational_config_json", "TEXT NOT NULL DEFAULT '{}'"],
        ["projects", "control_policy_json", "TEXT NOT NULL DEFAULT '{}'"],
        ["projects", "post_merge_smoke_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["tasks", "proposed_risk_class", "TEXT NOT NULL DEFAULT 'normal'"],
        ["tasks", "environment_requirements_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["tasks", "revert_safe", "INTEGER NOT NULL DEFAULT 0"],
        ["tasks", "current_revision_id", "TEXT"],
        ["agents", "runtime_family", "TEXT NOT NULL DEFAULT 'command'"],
        ["agents", "runtime_capabilities_json", "TEXT NOT NULL DEFAULT '{}'"],
        ["agents", "health_successes", "INTEGER NOT NULL DEFAULT 0"],
        ["agents", "health_failures", "INTEGER NOT NULL DEFAULT 0"],
        ["agents", "last_assigned_at", "TEXT"],
        ["agents", "runtime_version", "TEXT"],
        ["runs", "runtime_session_id", "TEXT"],
        ["runs", "runtime_version", "TEXT"],
        ["runs", "task_revision_id", "TEXT"],
        ["runs", "context_fingerprint", "TEXT"],
      ] as const) {
        if (!this.tableHasColumn(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_revisions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          scope_json TEXT NOT NULL,
          proposed_risk_class TEXT NOT NULL,
          effective_risk_class TEXT NOT NULL,
          gate_profile_json TEXT NOT NULL,
          environment_requirements_json TEXT NOT NULL,
          context_fingerprint TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(task_id, revision)
        );
        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          run_id TEXT NOT NULL REFERENCES runs(id),
          task_revision_id TEXT NOT NULL REFERENCES task_revisions(id),
          signature TEXT NOT NULL,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          summary TEXT NOT NULL,
          file TEXT,
          line INTEGER,
          evidence TEXT,
          resolution_evidence TEXT,
          reviewer_agent_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_findings_task_status ON findings(task_id, status);
        CREATE INDEX IF NOT EXISTS idx_findings_signature ON findings(signature, status);
        CREATE TABLE IF NOT EXISTS outbox_messages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          decision_id TEXT REFERENCES decisions(id),
          dedupe_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          channel TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          next_attempt_at TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          acknowledged_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_messages(status, next_attempt_at, created_at);
      `);
      return;
    }
    if (version === 6) {
      if (!this.tableHasColumn("findings", "rule")) this.db.exec("ALTER TABLE findings ADD COLUMN rule TEXT");
      return;
    }
    if (version === 7) {
      if (!this.tableHasColumn("runs", "metrics_json")) this.db.exec("ALTER TABLE runs ADD COLUMN metrics_json TEXT");
      return;
    }
    if (version === 8) {
      if (!this.tableHasColumn("runs", "network_policy_digest")) this.db.exec("ALTER TABLE runs ADD COLUMN network_policy_digest TEXT");
      if (!this.tableHasColumn("runs", "gateway_status")) this.db.exec("ALTER TABLE runs ADD COLUMN gateway_status TEXT");
      return;
    }
    if (version === 9) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
          ON tasks(status, priority DESC, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_runs_jobs
          ON runs(started_at) WHERE job_json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_leases_agent
          ON agent_leases(agent_id);
        CREATE INDEX IF NOT EXISTS idx_findings_project_created
          ON findings(project_id, created_at);
      `);
      return;
    }
    throw new Error(`Unknown AEC-S database migration: ${version}`);
  }

  private tableHasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((candidate) => candidate.name === column);
  }

  createProject(input: ProjectInput): Project {
    input = projectInputSchema.parse(input) as ProjectInput;
    assertNoPersistedSecrets(input, "project", true);
    const project: Project = {
      id: input.id ?? newId("project"),
      name: input.name,
      repoPath: input.repoPath,
      targetBranch: input.targetBranch ?? "main",
      remoteName: input.remoteName ?? "origin",
      deliveryMode: input.deliveryMode ?? "local",
      intent: input.intent ?? "",
      intentVersion: input.intentVersion ?? 1,
      environmentContract: input.environmentContract ?? { version: 1, components: [] },
      operationalConfig: { ...DEFAULT_OPERATIONAL_CONFIG, ...input.operationalConfig },
      controlPolicy: { ...DEFAULT_CONTROL_POLICY, ...input.controlPolicy },
      defaultValidation: input.defaultValidation ?? [],
      fullValidation: input.fullValidation ?? [],
      postMergeSmoke: input.postMergeSmoke ?? [],
      requiredChecks: input.requiredChecks ?? [],
      highRiskGlobs: input.highRiskGlobs ?? [],
      maxConcurrency: input.maxConcurrency ?? 2,
      createdAt: nowIso(),
    };
    this.db
      .prepare(`INSERT INTO projects(
        id, name, repo_path, target_branch, remote_name, delivery_mode, intent,
        default_validation_json, full_validation_json, required_checks_json,
        high_risk_globs_json, max_concurrency, created_at, intent_version,
        environment_contract_json, operational_config_json, control_policy_json, post_merge_smoke_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...([
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
        project.intentVersion,
        JSON.stringify(project.environmentContract),
        JSON.stringify(project.operationalConfig),
        JSON.stringify(project.controlPolicy),
        JSON.stringify(project.postMergeSmoke),
      ] as SqlValue[]));
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
    assertNoPersistedSecrets(patch, "project.update", true);
    if (patch.intent !== undefined && patch.intent !== current.intent && patch.intentVersion !== (current.intentVersion ?? 1) + 1) {
      throw new Error("Changing Project Intent requires intentVersion to increase by exactly one");
    }
    if (patch.environmentContract && patch.environmentContract.version <= (current.environmentContract?.version ?? 1)) {
      throw new Error("Changing Environment Contract requires a higher version");
    }
    if (patch.controlPolicy && Object.keys(patch.controlPolicy).some((key) => key !== "version") &&
        patch.controlPolicy.version !== (current.controlPolicy?.version ?? 1) + 1) {
      throw new Error("Changing Control Policy requires its version to increase by exactly one");
    }
    const { createdAt: _createdAt, ...currentInput } = current;
    const next = projectInputSchema.parse({ ...currentInput, ...patch, id, name: current.name, repoPath: current.repoPath }) as ProjectInput;
    this.transaction(() => {
      this.db.prepare(`UPDATE projects SET target_branch=?, remote_name=?, delivery_mode=?, intent=?, intent_version=?,
        environment_contract_json=?, operational_config_json=?, control_policy_json=?, default_validation_json=?,
        full_validation_json=?, post_merge_smoke_json=?, required_checks_json=?, high_risk_globs_json=?, max_concurrency=? WHERE id=?`)
        .run(...([
        next.targetBranch ?? current.targetBranch,
        next.remoteName ?? current.remoteName,
        next.deliveryMode ?? current.deliveryMode,
        next.intent ?? current.intent,
        next.intentVersion ?? current.intentVersion,
        JSON.stringify(next.environmentContract ?? current.environmentContract),
        JSON.stringify({ ...current.operationalConfig, ...next.operationalConfig }),
        JSON.stringify({ ...current.controlPolicy, ...next.controlPolicy }),
        JSON.stringify(next.defaultValidation ?? current.defaultValidation),
        JSON.stringify(next.fullValidation ?? current.fullValidation),
        JSON.stringify(next.postMergeSmoke ?? current.postMergeSmoke),
        JSON.stringify(next.requiredChecks ?? current.requiredChecks),
        JSON.stringify(next.highRiskGlobs ?? current.highRiskGlobs),
        next.maxConcurrency ?? current.maxConcurrency,
          id,
        ] as SqlValue[]));
      const updated = this.getProject(id)!;
      for (const task of this.listTasks(id)) {
        if (["succeeded", "failed", "cancelled"].includes(task.status)) continue;
        const previous = task.currentRevisionId ? this.getTaskRevision(task.currentRevisionId) : undefined;
        if (!previous) continue;
        const revision: TaskRevision = {
          ...previous,
          id: newId("revision"),
          revision: previous.revision + 1,
          contextFingerprint: fingerprint({
            previous: previous.contextFingerprint,
            taskId: task.id,
            taskGoal: task.goal,
            scope: previous.scope,
            risk: previous.effectiveRiskClass,
            decisionIds: task.decisionIds,
            intent: updated.intent,
            intentVersion: updated.intentVersion,
            environmentContract: updated.environmentContract,
            controlPolicy: updated.controlPolicy,
            networkPolicy: updated.operationalConfig?.networkPolicy,
          }),
          reason: "calibration",
          createdAt: nowIso(),
        };
        this.insertTaskRevision(revision);
        this.db.prepare("UPDATE tasks SET current_revision_id=?, updated_at=? WHERE id=?")
          .run(revision.id, nowIso(), task.id);
        this.appendEvent({ projectId: id, taskId: task.id, type: "task.context_revised", payload: { revisionId: revision.id } });
      }
      this.appendEvent({ projectId: id, type: "project.updated", payload: { fields: Object.keys(patch) } });
    });
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
      intentVersion: Number(row.intent_version ?? 1),
      environmentContract: json(row.environment_contract_json, { version: 1, components: [] }),
      operationalConfig: { ...DEFAULT_OPERATIONAL_CONFIG, ...json(row.operational_config_json, {}) },
      controlPolicy: { ...DEFAULT_CONTROL_POLICY, ...json(row.control_policy_json, {}) },
      defaultValidation: json(row.default_validation_json, []),
      fullValidation: json(row.full_validation_json, []),
      postMergeSmoke: json(row.post_merge_smoke_json, []),
      requiredChecks: json(row.required_checks_json, []),
      highRiskGlobs: json(row.high_risk_globs_json, []),
      maxConcurrency: Number(row.max_concurrency),
      createdAt: String(row.created_at),
    };
  }

  createTask(input: TaskInput): Task {
    input = taskInputSchema.parse(input) as TaskInput;
    assertNoPersistedSecrets(input, "task", true);
    const timestamp = nowIso();
    const revisionId = newId("revision");
    const proposedRiskClass = input.proposedRiskClass ?? "normal";
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const pathRisk = project.highRiskGlobs.length > 0 && globsMayOverlap(input.scope.writeGlobs, project.highRiskGlobs);
    const docsOnly = input.scope.writeGlobs.length > 0 && input.scope.writeGlobs.every((path) =>
      path.endsWith(".md") || path.startsWith("docs/"));
    const effectiveRiskClass = proposedRiskClass === "core" || pathRisk
      ? "core"
      : proposedRiskClass === "docs" && !docsOnly ? "normal" : proposedRiskClass;
    const contextFingerprint = fingerprint({
      task: {
        id: input.id,
        title: input.title,
        goal: input.goal,
        constraints: input.constraints ?? [],
        acceptanceCriteria: input.acceptanceCriteria,
        decisionIds: input.decisionIds ?? [],
      },
      scope: input.scope,
      risk: effectiveRiskClass,
      environment: input.environmentRequirements ?? [],
      intent: project.intent,
      intentVersion: project.intentVersion,
      environmentContract: project.environmentContract,
      controlPolicy: project.controlPolicy,
      networkPolicy: project.operationalConfig?.networkPolicy,
    });
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
      proposedRiskClass,
      environmentRequirements: input.environmentRequirements ?? [],
      revertSafe: input.revertSafe ?? false,
      requiresFullValidation: input.requiresFullValidation ?? false,
      priority: input.priority ?? 0,
      ...(input.replacesTaskId ? { replacesTaskId: input.replacesTaskId } : {}),
      decisionIds: input.decisionIds ?? [],
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      currentRevisionId: revisionId,
    };
    return this.transaction(() => {
      this.db
      .prepare(`INSERT INTO tasks (
        id, project_id, title, goal, scope_json, depends_on_json, constraints_json,
        acceptance_json, validation_json, required_caps_json, requires_full, priority,
        replaces_task_id, decision_ids_json, status, terminal_summary, merge_sha, created_at, updated_at,
        proposed_risk_class, environment_requirements_json, revert_safe, current_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
      .run(...([
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
        task.proposedRiskClass,
        JSON.stringify(task.environmentRequirements),
        task.revertSafe ? 1 : 0,
        task.currentRevisionId ?? null,
      ] as SqlValue[]));
    const revision: TaskRevision = {
      id: revisionId,
      taskId: task.id,
      revision: 1,
      scope: task.scope,
      proposedRiskClass,
      effectiveRiskClass,
      gateProfile: {
        review: effectiveRiskClass === "core" ? "strict" : effectiveRiskClass === "docs" ? "none" : "standard",
        validation: effectiveRiskClass === "core" ? "applicable" : "minimal",
      },
      environmentRequirements: task.environmentRequirements ?? [],
      contextFingerprint,
      reason: "initial",
      createdAt: timestamp,
    };
    this.insertTaskRevision(revision);
    this.appendEvent({
      projectId: task.projectId,
      taskId: task.id,
      type: "task.created",
      payload: { title: task.title },
    });
      return task;
    });
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

  listTasksByStatus(status: TaskStatus): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status=? ORDER BY priority DESC, created_at, id").all(status) as Row[])
      .map((row) => this.taskFromRow(row));
  }

  listRunnableTasks(): Task[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE status='ready' ORDER BY priority DESC, created_at, id")
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

  updateTaskStatusUnlessControlled(
    id: string,
    status: TaskStatus,
    extra?: { summary?: string | null; mergeSha?: string | null },
  ): boolean {
    return this.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      if (["paused", "cancelled"].includes(task.status)) return false;
      const updatedAt = nowIso();
      const summary = extra && Object.hasOwn(extra, "summary") ? extra.summary ?? null : task.terminalSummary ?? null;
      const mergeSha = extra && Object.hasOwn(extra, "mergeSha") ? extra.mergeSha ?? null : task.mergeSha ?? null;
      const result = this.db
        .prepare("UPDATE tasks SET status = ?, terminal_summary = ?, merge_sha = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(status, summary, mergeSha, updatedAt, id, task.status);
      if (result.changes !== 1) return false;
      this.appendEvent({
        projectId: task.projectId,
        taskId: id,
        type: "task.status_changed",
        payload: { from: task.status, to: status },
      });
      return true;
    });
  }

  updateTaskPriority(id: string, priority: number): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    this.db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?").run(priority, nowIso(), id);
    this.appendEvent({
      projectId: task.projectId,
      taskId: id,
      type: "task.priority_changed",
      payload: { from: task.priority, to: priority },
    });
  }

  private taskFromRow(row: Row): Task {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      goal: String(row.goal),
      scope: normalizeStoredScope(json(row.scope_json, { writeGlobs: [], watchGlobs: [], tags: [] })),
      dependsOn: json(row.depends_on_json, []),
      constraints: json(row.constraints_json, []),
      acceptanceCriteria: json(row.acceptance_json, []),
      validationCommands: json(row.validation_json, []),
      requiredCapabilities: json(row.required_caps_json, []),
      proposedRiskClass: String(row.proposed_risk_class ?? "normal") as Task["proposedRiskClass"],
      environmentRequirements: json(row.environment_requirements_json, []),
      revertSafe: bool(row.revert_safe),
      requiresFullValidation: bool(row.requires_full),
      priority: Number(row.priority),
      ...(row.replaces_task_id ? { replacesTaskId: String(row.replaces_task_id) } : {}),
      decisionIds: json(row.decision_ids_json, []),
      status: String(row.status) as TaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      currentRevisionId: String(row.current_revision_id ?? `legacy-${String(row.id)}`),
      ...(row.terminal_summary ? { terminalSummary: String(row.terminal_summary) } : {}),
      ...(row.merge_sha ? { mergeSha: String(row.merge_sha) } : {}),
    };
  }

  private insertTaskRevision(revision: TaskRevision): void {
    this.db.prepare(`INSERT INTO task_revisions(
      id, task_id, revision, scope_json, proposed_risk_class, effective_risk_class,
      gate_profile_json, environment_requirements_json, context_fingerprint, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        revision.id,
        revision.taskId,
        revision.revision,
        JSON.stringify(revision.scope),
        revision.proposedRiskClass,
        revision.effectiveRiskClass,
        JSON.stringify(revision.gateProfile),
        JSON.stringify(revision.environmentRequirements),
        revision.contextFingerprint,
        revision.reason,
        revision.createdAt,
      );
  }

  getTaskRevision(id: string): TaskRevision | undefined {
    const row = this.db.prepare("SELECT * FROM task_revisions WHERE id=?").get(id) as Row | undefined;
    return row ? this.taskRevisionFromRow(row) : undefined;
  }

  listTaskRevisions(taskId: string): TaskRevision[] {
    return (this.db.prepare("SELECT * FROM task_revisions WHERE task_id=? ORDER BY revision").all(taskId) as Row[])
      .map((row) => this.taskRevisionFromRow(row));
  }

  createScopeExpansionRevision(
    taskId: string,
    proposal: { addWriteGlobs: string[]; addWatchGlobs: string[]; evidence: string },
  ): TaskRevision {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!proposal.evidence.trim()) throw new Error("Scope expansion requires evidence");
    const current = task.currentRevisionId ? this.getTaskRevision(task.currentRevisionId) : undefined;
    if (!current) throw new Error(`Task Revision not found: ${String(task.currentRevisionId)}`);
    const scope = taskScopeSchema.parse({
      writeGlobs: [...new Set([...current.scope.writeGlobs, ...proposal.addWriteGlobs])],
      watchGlobs: [...new Set([...(current.scope.watchGlobs ?? []), ...proposal.addWatchGlobs])],
      tags: current.scope.tags,
    });
    if (scope.writeGlobs.length === current.scope.writeGlobs.length &&
        scope.watchGlobs.length === (current.scope.watchGlobs ?? []).length) {
      throw new Error("Scope expansion must add at least one new write or watch glob");
    }
    const project = this.getProject(task.projectId)!;
    const hitsRiskFloor = project.highRiskGlobs.length > 0 && globsMayOverlap(scope.writeGlobs, project.highRiskGlobs);
    const docsOnly = scope.writeGlobs.length > 0 && scope.writeGlobs.every((path) =>
      path.endsWith(".md") || path.startsWith("docs/"));
    const effectiveRiskClass = current.effectiveRiskClass === "core" || hitsRiskFloor
      ? "core"
      : current.effectiveRiskClass === "docs" && !docsOnly ? "normal" : current.effectiveRiskClass;
    const revision: TaskRevision = {
      ...current,
      id: newId("revision"),
      revision: current.revision + 1,
      scope,
      effectiveRiskClass,
      gateProfile: {
        review: effectiveRiskClass === "core" ? "strict" : effectiveRiskClass === "docs" ? "none" : "standard",
        validation: effectiveRiskClass === "core" ? "applicable" : "minimal",
      },
      contextFingerprint: fingerprint({
        previous: current.contextFingerprint,
        taskId: task.id,
        taskGoal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
        decisionIds: task.decisionIds,
        scope,
        risk: effectiveRiskClass,
        intent: project.intent,
        intentVersion: project.intentVersion,
        environmentContract: project.environmentContract,
        controlPolicy: project.controlPolicy,
        networkPolicy: project.operationalConfig?.networkPolicy,
      }),
      reason: "scope_expansion",
      createdAt: nowIso(),
    };
    this.transaction(() => {
      this.insertTaskRevision(revision);
      this.db.prepare("UPDATE tasks SET scope_json=?, current_revision_id=?, proposed_risk_class=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(scope), revision.id, revision.proposedRiskClass, nowIso(), taskId);
      this.appendEvent({
        projectId: task.projectId,
        taskId,
        type: "task.scope_expanded",
        payload: { revisionId: revision.id, evidence: redactText(proposal.evidence) },
      });
    });
    return revision;
  }

  createRiskElevationRevision(taskId: string, evidence: string): TaskRevision {
    const task = this.getTask(taskId);
    if (!task?.currentRevisionId) throw new Error(`Task Revision not found: ${taskId}`);
    const current = this.getTaskRevision(task.currentRevisionId);
    if (!current) throw new Error(`Task Revision not found: ${task.currentRevisionId}`);
    if (current.effectiveRiskClass === "core") return current;
    evidence = redactText(evidence);
    const revision: TaskRevision = {
      ...current,
      id: newId("revision"),
      revision: current.revision + 1,
      effectiveRiskClass: "core",
      gateProfile: { review: "strict", validation: "applicable" },
      contextFingerprint: fingerprint({ previous: current.contextFingerprint, effectiveRiskClass: "core", evidence }),
      reason: "calibration",
      createdAt: nowIso(),
    };
    this.transaction(() => {
      this.insertTaskRevision(revision);
      this.db.prepare("UPDATE tasks SET current_revision_id=?, updated_at=? WHERE id=?").run(revision.id, nowIso(), taskId);
      this.appendEvent({
        projectId: task.projectId,
        taskId,
        type: "task.risk_elevated",
        payload: { revisionId: revision.id, evidence },
      });
    });
    return revision;
  }

  private taskRevisionFromRow(row: Row): TaskRevision {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      revision: Number(row.revision),
      scope: normalizeStoredScope(json(row.scope_json, {})),
      proposedRiskClass: String(row.proposed_risk_class) as TaskRevision["proposedRiskClass"],
      effectiveRiskClass: String(row.effective_risk_class) as TaskRevision["effectiveRiskClass"],
      gateProfile: json(row.gate_profile_json, { review: "standard", validation: "minimal" }),
      environmentRequirements: json(row.environment_requirements_json, []),
      contextFingerprint: String(row.context_fingerprint),
      reason: String(row.reason) as TaskRevision["reason"],
      createdAt: String(row.created_at),
    };
  }

  createAgent(input: AgentInput): Agent {
    input = agentInputSchema.parse(input) as AgentInput;
    assertNoPersistedSecrets(input.config ?? {}, "agent.config", true);
    const agent: Agent = {
      id: input.id ?? newId("agent"),
      name: input.name,
      adapter: input.adapter,
      runtimeFamily: input.runtimeFamily ?? input.adapter,
      roles: input.roles,
      capabilities: input.capabilities ?? [],
      enabled: input.enabled ?? true,
      availability: input.enabled === false ? "disabled" : input.availability ?? "available",
      maxConcurrency: input.maxConcurrency ?? 1,
      currentLoad: 0,
      config: input.config ?? {},
      runtimeCapabilities: {
        resume: input.runtimeCapabilities?.resume ?? input.adapter !== "command",
        cancel: input.runtimeCapabilities?.cancel ?? true,
        stream: input.runtimeCapabilities?.stream ?? ["kimi", "deepseek_harness"].includes(input.adapter),
        reviewMode: input.runtimeCapabilities?.reviewMode ?? input.roles.includes("reviewer"),
        structuredOutput: input.runtimeCapabilities?.structuredOutput ?? input.adapter !== "command",
      },
      healthSuccesses: 0,
      healthFailures: 0,
    };
    this.db
      .prepare(`INSERT INTO agents(
        id, name, adapter, roles_json, capabilities_json, enabled, availability,
        max_concurrency, current_load, config_json, runtime_family, runtime_capabilities_json,
        health_successes, health_failures, last_assigned_at, runtime_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...([
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
        agent.runtimeFamily,
        JSON.stringify(agent.runtimeCapabilities),
        agent.healthSuccesses,
        agent.healthFailures,
        agent.lastAssignedAt ?? null,
        agent.runtimeVersion ?? null,
      ] as SqlValue[]));
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
    const {
      currentLoad: _currentLoad,
      healthSuccesses: _healthSuccesses,
      healthFailures: _healthFailures,
      lastAssignedAt: _lastAssignedAt,
      runtimeVersion: _runtimeVersion,
      ...currentInput
    } = current;
    const next = agentInputSchema.parse({ ...currentInput, ...patch, id, name: current.name, adapter: current.adapter }) as AgentInput;
    assertNoPersistedSecrets(next.config ?? {}, "agent.config", true);
    const enabled = next.enabled ?? current.enabled;
    const availability = !enabled
      ? "disabled"
      : current.availability === "disabled" && patch.enabled === true ? "registered" : next.availability ?? current.availability;
    const resetHealth = patch.availability !== undefined;
    this.db.prepare(`UPDATE agents SET roles_json=?, capabilities_json=?, enabled=?, availability=?,
      max_concurrency=?, config_json=?, runtime_family=?, runtime_capabilities_json=?,
      health_successes=?, health_failures=? WHERE id=?`)
      .run(...([
        JSON.stringify(next.roles ?? current.roles),
        JSON.stringify(next.capabilities ?? current.capabilities),
        enabled ? 1 : 0,
        availability,
        next.maxConcurrency ?? current.maxConcurrency,
        JSON.stringify(next.config ?? current.config),
        next.runtimeFamily ?? current.runtimeFamily,
        JSON.stringify({ ...current.runtimeCapabilities, ...next.runtimeCapabilities }),
        resetHealth ? 0 : current.healthSuccesses ?? 0,
        resetHealth ? 0 : current.healthFailures ?? 0,
        id,
      ] as SqlValue[]));
    this.appendEvent({ type: "agent.updated", payload: { agentId: id, fields: Object.keys(patch) } });
    return this.getAgent(id)!;
  }

  reserveAgentSlot(agentId: string, runId: string, jobId: string): boolean {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (!agent || !agent.enabled || !["available", "busy", "degraded"].includes(agent.availability)) return false;
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM agent_leases WHERE agent_id=?").get(agentId) as Row).count);
      if (count >= agent.maxConcurrency) return false;
      const result = this.db.prepare("INSERT OR IGNORE INTO agent_leases(job_id, agent_id, run_id, created_at) VALUES (?, ?, ?, ?)")
        .run(jobId, agentId, runId, nowIso());
      if (result.changes === 1) {
        this.db.prepare("UPDATE agents SET last_assigned_at=? WHERE id=?").run(nowIso(), agentId);
      }
      this.db.prepare("UPDATE agents SET current_load=(SELECT COUNT(*) FROM agent_leases WHERE agent_id=?) WHERE id=?")
        .run(agentId, agentId);
      this.db.prepare("UPDATE agents SET availability='busy' WHERE id=? AND availability='available' AND current_load>=max_concurrency")
        .run(agentId);
      return result.changes === 1;
    });
  }

  ensureAgentSlot(agentId: string, runId: string, jobId: string): void {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO agent_leases(job_id, agent_id, run_id, created_at) VALUES (?, ?, ?, ?)")
        .run(jobId, agentId, runId, nowIso());
      this.db.prepare("UPDATE agents SET current_load=(SELECT COUNT(*) FROM agent_leases WHERE agent_id=?) WHERE id=?")
        .run(agentId, agentId);
      this.db.prepare("UPDATE agents SET availability='busy' WHERE id=? AND availability='available' AND current_load>=max_concurrency")
        .run(agentId);
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
        this.db.prepare("UPDATE agents SET availability='available' WHERE id=? AND availability='busy' AND current_load<max_concurrency")
          .run(agentId);
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
      runtimeFamily: String(row.runtime_family ?? row.adapter),
      roles: json(row.roles_json, []),
      capabilities: json(row.capabilities_json, []),
      enabled: bool(row.enabled),
      availability: String(row.availability) as Agent["availability"],
      maxConcurrency: Number(row.max_concurrency),
      currentLoad: Number(row.current_load),
      config: json(row.config_json, {}),
      runtimeCapabilities: json(row.runtime_capabilities_json, {
        resume: false, cancel: true, stream: false, reviewMode: false, structuredOutput: false,
      }),
      healthSuccesses: Number(row.health_successes ?? 0),
      healthFailures: Number(row.health_failures ?? 0),
      ...(row.last_assigned_at ? { lastAssignedAt: String(row.last_assigned_at) } : {}),
      ...(row.runtime_version ? { runtimeVersion: String(row.runtime_version) } : {}),
    };
  }

  recordAgentHealth(agentId: string, healthy: boolean, version?: string): Agent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const projects = this.listProjects();
    const failureThreshold = projects.length > 0
      ? Math.min(...projects.map((project) => project.operationalConfig?.healthFailureThreshold ?? 3))
      : 3;
    const recoveryThreshold = projects.length > 0
      ? Math.min(...projects.map((project) => project.operationalConfig?.healthRecoveryThreshold ?? 2))
      : 2;
    const successes = healthy ? (agent.healthSuccesses ?? 0) + 1 : 0;
    const failures = healthy ? 0 : (agent.healthFailures ?? 0) + 1;
    let availability = agent.availability;
    if (!agent.enabled) availability = "disabled";
    else if (!healthy && failures >= failureThreshold) availability = "unavailable";
    else if (!healthy && ["available", "busy"].includes(agent.availability)) availability = agent.availability;
    else if (!healthy) availability = "degraded";
    else if (agent.availability === "registered" || successes >= recoveryThreshold || ["available", "healthy", "busy"].includes(agent.availability)) {
      availability = agent.currentLoad >= agent.maxConcurrency ? "busy" : "available";
    }
    else availability = "degraded";
    this.db.prepare(`UPDATE agents SET health_successes=?, health_failures=?, availability=?, runtime_version=COALESCE(?, runtime_version)
      WHERE id=?`).run(successes, failures, availability, version ?? null, agentId);
    return this.getAgent(agentId)!;
  }

  markAgentAssigned(agentId: string): void {
    this.db.prepare("UPDATE agents SET last_assigned_at=? WHERE id=?").run(nowIso(), agentId);
  }

  createRun(run: Run): Run {
    this.db
      .prepare(`INSERT INTO runs (
        id, task_id, agent_id, workspace_id, phase, status, attempt, repair_count,
        rotation_count, base_sha, codex_session_id, worker_result_json, worker_result_path, validation_json, review_json,
        effects_json, job_json, log_dir, diff_path, error_json, started_at, updated_at, lease_until, lease_owner,
        runtime_session_id, runtime_version, task_revision_id, context_fingerprint, metrics_json,
        network_policy_digest, gateway_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        effects_json=?, job_json=?, log_dir=?, diff_path=?, error_json=?, started_at=?, updated_at=?, lease_until=?, lease_owner=?,
        runtime_session_id=?, runtime_version=?, task_revision_id=?, context_fingerprint=?, metrics_json=?,
        network_policy_digest=?, gateway_status=?
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
      run.runtimeSessionId ?? null,
      run.runtimeVersion ?? null,
      run.taskRevisionId ?? null,
      run.contextFingerprint ?? null,
      run.metrics ? JSON.stringify(run.metrics) : null,
      run.networkPolicyDigest ?? null,
      run.gatewayStatus ?? null,
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
    const row = this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as Row | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listRuns(taskId?: string): Run[] {
    const rows = taskId
      ? (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId) as Row[])
      : (this.db.prepare("SELECT * FROM runs ORDER BY started_at").all() as Row[]);
    return rows.map((row) => this.runFromRow(row));
  }

  listRunsWithJobs(): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE job_json IS NOT NULL ORDER BY started_at, rowid").all() as Row[])
      .map((row) => this.runFromRow(row));
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
      ...(row.runtime_session_id ? { runtimeSessionId: String(row.runtime_session_id) } : {}),
      ...(row.runtime_version ? { runtimeVersion: String(row.runtime_version) } : {}),
      ...(row.task_revision_id ? { taskRevisionId: String(row.task_revision_id) } : {}),
      ...(row.context_fingerprint ? { contextFingerprint: String(row.context_fingerprint) } : {}),
      ...(row.network_policy_digest ? { networkPolicyDigest: String(row.network_policy_digest) } : {}),
      ...(row.gateway_status ? { gatewayStatus: String(row.gateway_status) as Run["gatewayStatus"] } : {}),
      ...(row.metrics_json ? { metrics: json(row.metrics_json, undefined) } : {}),
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
    return this.workspaceFromRow(row);
  }

  private workspaceFromRow(row: Row): Workspace {
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
      ? (this.db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM workspaces ORDER BY created_at").all() as Row[]);
    return rows.map((row) => this.workspaceFromRow(row));
  }

  updateWorkspaceStatus(id: string, status: WorkspaceStatus): void {
    this.db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  }

  updateWorkspaceBaseline(id: string, baseSha: string, status?: WorkspaceStatus): void {
    if (status) {
      this.db.prepare("UPDATE workspaces SET base_sha = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(baseSha, status, nowIso(), id);
    } else {
      this.db.prepare("UPDATE workspaces SET base_sha = ?, updated_at = ? WHERE id = ?")
        .run(baseSha, nowIso(), id);
    }
  }

  createDecision(input: DecisionInput): Decision {
    input = decisionInputSchema.parse(input) as DecisionInput;
    input = redactJson(input);
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
    return this.transaction(() => {
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
    if (decision.status === "pending") {
      this.enqueueOutbox({
        projectId: decision.projectId,
        decisionId: decision.id,
        dedupeKey: `decision:${decision.id}:mcp`,
        channel: "mcp",
        title: decision.title,
        body: decision.body,
      });
      this.enqueueOutbox({
        projectId: decision.projectId,
        decisionId: decision.id,
        dedupeKey: `decision:${decision.id}:system`,
        channel: "system",
        title: decision.title,
        body: decision.body,
      });
    }
      return decision;
    });
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
    resolution = redactJson(resolution);
    return this.transaction(() => {
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
      for (const message of this.listOutbox(decision.projectId).filter((item) => item.decisionId === id)) {
        this.acknowledgeOutbox(message.id);
      }
      return this.getDecision(id)!;
    });
  }

  private decisionFromRow(row: Row): Decision {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      kind: String(row.kind) as Decision["kind"],
      status: String(row.status) as Decision["status"],
      title: redactText(String(row.title)),
      body: redactText(String(row.body)),
      options: redactJson(json(row.options_json, [])),
      ...(row.resolution_json ? { resolution: redactJson(json(row.resolution_json, {})) } : {}),
      createdAt: String(row.created_at),
      ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
    };
  }

  createFinding(input: Omit<Finding, "id" | "status" | "signature" | "createdAt" | "updatedAt">): Finding {
    input = redactJson(input);
    const revision = this.getTaskRevision(input.taskRevisionId);
    const signature = fingerprint({
      taskRevisionId: input.taskRevisionId,
      contextFingerprint: revision?.contextFingerprint,
      rule: input.rule ?? null,
      severity: input.severity,
      summary: input.summary.trim().toLowerCase(),
      file: input.file ?? null,
      line: input.line ?? null,
    });
    return this.transaction(() => {
      const active = this.db.prepare(`SELECT * FROM findings
      WHERE signature=? AND task_revision_id=? AND status IN ('structurally_valid','verified')
      ORDER BY updated_at DESC LIMIT 1`).get(signature, input.taskRevisionId) as Row | undefined;
    if (active) return this.findingFromRow(active);
    const dismissed = this.db.prepare(`SELECT * FROM findings
      WHERE signature=? AND task_revision_id=? AND status='dismissed' ORDER BY updated_at DESC LIMIT 1`)
      .get(signature, input.taskRevisionId) as Row | undefined;
    if (dismissed) return this.findingFromRow(dismissed);
    const timestamp = nowIso();
    const finding: Finding = {
      ...input,
      id: newId("finding"),
      signature,
      status: "structurally_valid",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO findings(
      id, project_id, task_id, run_id, task_revision_id, signature, status, severity,
      summary, rule, file, line, evidence, resolution_evidence, reviewer_agent_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        finding.id, finding.projectId, finding.taskId, finding.runId, finding.taskRevisionId,
        finding.signature, finding.status, finding.severity, finding.summary, finding.rule ?? null, finding.file ?? null,
        finding.line ?? null, finding.evidence ?? null, finding.resolutionEvidence ?? null,
        finding.reviewerAgentId ?? null, finding.createdAt, finding.updatedAt,
      );
    this.appendEvent({
      projectId: finding.projectId,
      taskId: finding.taskId,
      runId: finding.runId,
      type: "finding.created",
      payload: { findingId: finding.id, signature },
    });
      return finding;
    });
  }

  getFinding(id: string): Finding | undefined {
    const row = this.db.prepare("SELECT * FROM findings WHERE id=?").get(id) as Row | undefined;
    return row ? this.findingFromRow(row) : undefined;
  }

  listFindings(taskId?: string, status?: FindingStatus): Finding[] {
    const where: string[] = [];
    const args: string[] = [];
    if (taskId) { where.push("task_id=?"); args.push(taskId); }
    if (status) { where.push("status=?"); args.push(status); }
    const sql = `SELECT * FROM findings${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((row) => this.findingFromRow(row));
  }

  listProjectFindings(projectId?: string): Finding[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM findings WHERE project_id=? ORDER BY created_at").all(projectId) as Row[]
      : this.db.prepare("SELECT * FROM findings ORDER BY created_at").all() as Row[];
    return rows.map((row) => this.findingFromRow(row));
  }

  transitionFinding(
    id: string,
    status: Extract<FindingStatus, "verified" | "dismissed" | "resolved">,
    evidence: string,
    actorAgentId: string,
  ): Finding {
    evidence = redactText(evidence);
    return this.transaction(() => {
      const finding = this.getFinding(id);
      if (!finding) throw new Error(`Finding not found: ${id}`);
      if (!evidence.trim()) throw new Error("Finding transition requires evidence");
      const allowed = status === "verified"
        ? finding.status === "structurally_valid"
        : status === "dismissed"
          ? ["structurally_valid", "verified"].includes(finding.status)
          : finding.status === "verified";
      if (!allowed) throw new Error(`Invalid Finding transition: ${finding.status} -> ${status}`);
      const run = this.getRun(finding.runId);
      if (run?.agentId === actorAgentId && ["dismissed", "resolved"].includes(status)) {
        throw new Error("Implementer cannot terminate a Finding against its own Run");
      }
      const actor = this.getAgent(actorAgentId);
      if (!actor?.enabled || !actor.roles.includes("reviewer")) {
        throw new Error("Finding transitions require an enabled Reviewer identity");
      }
      const result = this.db.prepare(`UPDATE findings SET status=?, evidence=CASE WHEN ?='verified' THEN ? ELSE evidence END,
        resolution_evidence=CASE WHEN ?!='verified' THEN ? ELSE resolution_evidence END, updated_at=? WHERE id=? AND status=?`)
        .run(status, status, evidence, status, evidence, nowIso(), id, finding.status);
      if (result.changes !== 1) throw new Error(`Finding changed while applying transition: ${id}`);
      this.appendEvent({
        projectId: finding.projectId,
        taskId: finding.taskId,
        runId: finding.runId,
        type: `finding.${status}`,
        payload: { findingId: id, actorAgentId },
      });
      return this.getFinding(id)!;
    });
  }

  hasVerifiedBlockingFindings(taskId: string, taskRevisionId?: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS present FROM findings
      WHERE task_id=? AND status='verified' AND severity='blocking'
        AND (? IS NULL OR task_revision_id=?) LIMIT 1`).get(taskId, taskRevisionId ?? null, taskRevisionId ?? null) as Row | undefined;
    return Boolean(row);
  }

  private findingFromRow(row: Row): Finding {
    return {
      id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id),
      runId: String(row.run_id), taskRevisionId: String(row.task_revision_id), signature: String(row.signature),
      status: String(row.status) as FindingStatus, severity: String(row.severity) as Finding["severity"],
      summary: redactText(String(row.summary)), ...(row.rule ? { rule: redactText(String(row.rule)) } : {}), ...(row.file ? { file: String(row.file) } : {}),
      ...(row.line ? { line: Number(row.line) } : {}), ...(row.evidence ? { evidence: redactText(String(row.evidence)) } : {}),
      ...(row.resolution_evidence ? { resolutionEvidence: redactText(String(row.resolution_evidence)) } : {}),
      ...(row.reviewer_agent_id ? { reviewerAgentId: String(row.reviewer_agent_id) } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  enqueueOutbox(input: Pick<OutboxMessage, "projectId" | "decisionId" | "dedupeKey" | "channel" | "title" | "body">): OutboxMessage {
    input = redactJson(input);
    const message: OutboxMessage = {
      id: newId("outbox"), projectId: input.projectId, ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      dedupeKey: input.dedupeKey, status: "pending", channel: input.channel,
      title: input.title, body: input.body, attempts: 0, createdAt: nowIso(),
    };
    return this.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO outbox_messages(
        id, project_id, decision_id, dedupe_key, status, channel, title, body, attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(message.id, message.projectId, message.decisionId ?? null, message.dedupeKey, message.status,
          message.channel, message.title, message.body, message.attempts, message.createdAt);
      const row = this.db.prepare("SELECT * FROM outbox_messages WHERE dedupe_key=?").get(input.dedupeKey) as Row | undefined;
      if (!row) throw new Error(`Outbox message could not be persisted: ${input.dedupeKey}`);
      return this.outboxFromRow(row);
    });
  }

  listOutbox(projectId?: string, pendingOnly = false): OutboxMessage[] {
    const where: string[] = [];
    const args: string[] = [];
    if (projectId) { where.push("project_id=?"); args.push(projectId); }
    if (pendingOnly) where.push("status IN ('pending','delivering','delivered')");
    const sql = `SELECT * FROM outbox_messages${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((row) => this.outboxFromRow(row));
  }

  listDeliverableOutbox(channel: OutboxMessage["channel"], at = nowIso()): OutboxMessage[] {
    return (this.db.prepare(`SELECT * FROM outbox_messages
      WHERE channel=? AND status IN ('pending','delivering')
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      ORDER BY created_at, id`).all(channel, at) as Row[]).map((row) => this.outboxFromRow(row));
  }

  claimOutboxDelivery(id: string, at: string, leaseUntil: string): OutboxMessage | undefined {
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE outbox_messages
        SET status='delivering', attempts=attempts+1, next_attempt_at=?
        WHERE id=? AND status IN ('pending','delivering')
          AND (next_attempt_at IS NULL OR next_attempt_at<=?)`).run(leaseUntil, id, at);
      if (result.changes !== 1) return undefined;
      const row = this.db.prepare("SELECT * FROM outbox_messages WHERE id=?").get(id) as Row | undefined;
      return row ? this.outboxFromRow(row) : undefined;
    });
  }

  markOutboxDeliveryFailed(id: string, nextAttemptAt: string): OutboxMessage {
    this.db.prepare(`UPDATE outbox_messages SET status='pending', next_attempt_at=?
      WHERE id=? AND status='delivering'`).run(nextAttemptAt, id);
    const row = this.db.prepare("SELECT * FROM outbox_messages WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Outbox message not found: ${id}`);
    return this.outboxFromRow(row);
  }

  markOutboxDelivered(id: string): OutboxMessage {
    this.db.prepare(`UPDATE outbox_messages SET status='delivered',
      attempts=attempts+CASE WHEN status='pending' THEN 1 ELSE 0 END,
      next_attempt_at=NULL, delivered_at=? WHERE id=? AND status!='acknowledged'`).run(nowIso(), id);
    const row = this.db.prepare("SELECT * FROM outbox_messages WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Outbox message not found: ${id}`);
    return this.outboxFromRow(row);
  }

  acknowledgeOutbox(id: string): OutboxMessage {
    this.db.prepare("UPDATE outbox_messages SET status='acknowledged', acknowledged_at=? WHERE id=?")
      .run(nowIso(), id);
    const row = this.db.prepare("SELECT * FROM outbox_messages WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Outbox message not found: ${id}`);
    return this.outboxFromRow(row);
  }

  private outboxFromRow(row: Row): OutboxMessage {
    return {
      id: String(row.id), projectId: String(row.project_id), ...(row.decision_id ? { decisionId: String(row.decision_id) } : {}),
      dedupeKey: String(row.dedupe_key), status: String(row.status) as OutboxMessage["status"],
      channel: String(row.channel) as OutboxMessage["channel"], title: redactText(String(row.title)), body: redactText(String(row.body)),
      attempts: Number(row.attempts), ...(row.next_attempt_at ? { nextAttemptAt: String(row.next_attempt_at) } : {}),
      createdAt: String(row.created_at), ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
      ...(row.acknowledged_at ? { acknowledgedAt: String(row.acknowledged_at) } : {}),
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
        JSON.stringify(redactJson(input.payload ?? {})),
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
      payload: redactJson(json(row.payload_json, {})),
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
    return redactJson({
      projects,
      tasks,
      runs,
      agents: this.listAgents(),
      workspaces: this.listWorkspaces(projectId),
      decisions: this.listDecisions(projectId),
      findings: this.listProjectFindings(projectId),
      outbox: this.listOutbox(projectId),
      events: this.listEvents(projectId),
    });
  }
}
