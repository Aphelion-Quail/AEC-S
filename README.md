# AEC-S — Agent Equilibrium Control System

**English** | [简体中文](README.zh-CN.md)

> This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) for noncommercial use only. Redistributions must preserve the [Attribution Notice](NOTICE). See [Commercial Licensing](COMMERCIAL-LICENSING.md) for commercial use.

AEC-S is a local control plane for multi-agent software engineering collaboration. Agents reason, implement, and review; AEC-S persists engineering state, isolates workspaces, enforces authoritative gates, and reconciles Git and GitHub side effects.

This repository implements the complete planned MVP: SQLite state, immutable task DAGs, Codex and generic command adapters, parallel worktrees, scoped validation, independent review and repair, restart recovery, MCP, human decision entry points, and GitHub PR/check/squash-merge delivery.

## Core invariants

- AEC-S is the sole source of control state for tasks, runs, agents, workspaces, validations, reviews, and decisions.
- Git is the source of truth for code and commits; GitHub is the source of truth for pull requests, checks, and merges. AEC-S queries external facts before retrying side effects.
- Each task uses an isolated worktree. `baseSha` records provenance; it is not a global lock.
- A changed `HEAD` does not interrupt an active agent or directly change task state.
- Ordinary tasks run only the project's lightweight baseline and commands explicitly declared by the task. Full validation is added only when explicitly requested, when scope is uncertain, or when high-risk paths are involved.
- Reviewers receive only the task, constraints, diff, and validation results, never the executor conversation.
- Front agents call the Core through CLI or MCP and cannot write SQLite directly.

## Requirements

- macOS (the LaunchAgent service is macOS-only)
- Node.js 26+
- Git
- Codex CLI (for real agent tasks)
- GitHub CLI `gh` (for GitHub delivery)

Install and verify:

```bash
npm install
npm run build
npm test
node dist/src/cli.js doctor
```

The default state directory is `~/Library/Application Support/AEC-S`. Set `AEC_S_HOME` to use a separate directory. It contains `aec-s.db`, run logs and envelopes, and worktrees.

## Shortest local loop

First copy the files in `examples/` and replace their absolute repository paths, commands, and scopes. Local delivery requires the project's `targetBranch` to be currently checked out in the main repository and the main worktree to be clean; `aec-s doctor` reports these conditions before a run:

```bash
npm run build
node dist/src/cli.js project add examples/project.local.json
node dist/src/cli.js agent add examples/agent.codex.json
node dist/src/cli.js agent add examples/agent.codex-reviewer.json
node dist/src/cli.js decision record examples/decision.json
node dist/src/cli.js graph submit examples/task-graph.json
node dist/src/cli.js run
node dist/src/cli.js status example-project
```

Task definitions are immutable after submission. To change direction, cancel the old task and submit a new task with `replacesTaskId`.

## Scheduling and validation

Scheduling considers only roles, required capabilities, availability, and current load. Global concurrency defaults to 2, project concurrency is limited by `maxConcurrency`, and a project's Git publishing section is always serialized.

Two tasks run concurrently only when their scopes can be proven disjoint:

```text
A.write ∩ (B.write ∪ B.impact) = ∅
B.write ∩ (A.write ∪ A.impact) = ∅
```

Task input must explicitly provide `writeGlobs` and `impactGlobs`. An empty `writeGlobs` means the scope cannot be determined, so execution is conservatively serialized and full validation is triggered. An explicitly empty `impactGlobs` means the submitter confirms that there is no additional impact scope. Workers may debug freely and run exploratory tests during execution; AEC-S recognizes only the following commands as authoritative gates:

1. Project `defaultValidation`
2. Task `validationCommands`
3. Project `fullValidation` when its conditions are met

The MVP intentionally supports a restricted glob subset: `*` matches any characters within one path segment, `?` matches one non-`/` character, and `**` may cross path segments. Character classes and braces have no expansion semantics. Every pattern must be repository-relative. If AEC-S cannot prove two patterns disjoint, it conservatively serializes the tasks.

When the target branch changes during task execution, AEC-S compares `oldBase..newBase` only at the publishing boundary. Unrelated changes reuse existing validation and review results. Related changes rerun only that task's authoritative validation and review. Conflicts enter repair.

## Daemon and recovery

Synchronous execution is useful for debugging:

```bash
node dist/src/cli.js run
```

Install the user LaunchAgent:

```bash
node dist/src/cli.js service install
node dist/src/cli.js service status
node dist/src/cli.js service restart
```

Agent and validation commands run under an independent job supervisor. Output, final results, and PIDs are persisted; timeouts terminate the entire child process group. After a daemon restart, AEC-S waits for a live job, consumes a completed job, or resumes from the latest safe phase. Run writes are fenced by lease ownership, and agent concurrency is controlled by atomic database slots. Commit, push, PR, and merge operations use deterministic operation IDs. An `uncertain` operation is reconciled instead of blindly retried.

The LaunchAgent stores a stable background `PATH` covering Homebrew, system tools, common user bins, and ChatGPT's bundled Codex by default. Set `AEC_S_SERVICE_PATH` before installation to override it. The daemon periodically probes enabled agents: a failed probe marks an agent `degraded`, recovery marks it `available` again, and an explicitly `offline` agent is never changed automatically.

Ordinary Git, GitHub, validator-launch, and other runtime infrastructure failures use persistent exponential backoff, with five attempts by default. A `failure_exhausted` human decision is created only after retries are exhausted. A nonzero exit after a validation command starts normally remains a code-gate failure and enters repair; failure to launch the command is an operational failure and does not ask an agent to change code.

## CLI control plane

```text
aec-s project add|list|show|update [...]
aec-s agent add|list|show|update [...]
aec-s status [project-id]
aec-s graph submit <graph.json>
aec-s directive apply <directive.json>
aec-s task pause|resume|cancel <task-id>
aec-s decision list [project-id]
aec-s decision show <decision-id>
aec-s decision resolve <decision-id> <resolution.json>
aec-s decision record <decision.json>
aec-s doctor
```

Example human resolution:

```json
{ "action": "retry_with_agent", "agentId": "codex-executor-2" }
```

The system creates a pending decision only when existing decisions cannot resolve an architectural or product tradeoff, or when allowed agent attempts and rotations are exhausted.

## MCP

stdio server:

```bash
node /absolute/path/to/AEC-S/dist/src/cli.js mcp
```

It exposes six tools:

- `aec_s_status`
- `aec_s_submit_task_graph`
- `aec_s_apply_directive`
- `aec_s_list_decisions`
- `aec_s_resolve_decision`
- `aec_s_record_decision`

Example configuration for a generic MCP client:

```json
{
  "mcpServers": {
    "aec-s": {
      "command": "node",
      "args": ["/absolute/path/to/AEC-S/dist/src/cli.js", "mcp"],
      "env": { "AEC_S_HOME": "/absolute/path/to/aec-s-state" }
    }
  }
}
```

The WorkBuddy desktop app can add the same stdio server through its bundled CLI. Ensure that its `AEC_S_HOME` is exactly the same as the LaunchAgent value:

```bash
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy \
  mcp add-json --scope user aec-s \
  '{"type":"stdio","command":"/opt/homebrew/bin/node","args":["/absolute/path/to/AEC-S/dist/src/cli.js","mcp"],"env":{"AEC_S_HOME":"/Users/you/Library/Application Support/AEC-S"}}'

/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy mcp get aec-s
```

If the WorkBuddy GUI connector accepts only HTTP or npx, use the local Streamable HTTP MCP endpoint started with the daemon:

```text
http://127.0.0.1:7337/mcp
```

The endpoint listens only on loopback and is not exposed to the LAN or internet. Set `AEC_S_MCP_HTTP_PORT` to change the port, then rerun `aec-s service install` so the LaunchAgent persists the new environment setting. The health endpoint is `http://127.0.0.1:7337/healthz`. AEC-S is not published as an npm package, so do not select npx in the GUI at this time.

WorkBuddy converts natural language into a structured task DAG, directive, or resolution. A minimal escalation integration can periodically call `aec_s_list_decisions(status="pending")`, deduplicate human notifications by decision ID, and return the decision through `aec_s_resolve_decision`. AEC-S does not need chat history as engineering memory.

## GitHub delivery

Run `gh auth login` and configure branch protection on the target repository. Then set the project's `deliveryMode` to `github` and explicitly configure nonempty `requiredChecks`. The flow is: fetch → worktree → validation/review → idempotent commit → force-with-lease push → create or reuse the same task PR → required checks → automatic squash merge using the expected PR head SHA → remote branch cleanup.

AEC-S does not use admin merge or bypass branch protection. Create real regression repositories only after authentication is valid and a human has explicitly confirmed the operation.

## Data and security boundaries

The MVP has seven entities: Project, Task, Run, Agent, Workspace, Event, and Decision. Validation, review, artifact paths, and external effect states are stored in the Run. Events are audit records, not an event-sourcing mechanism.

Register only repositories and commands you trust. Git worktrees provide write isolation, not a security sandbox. Codex executors and repair agents use an explicit workspace-write mode and workspace cwd; reviewers use read-only mode. Reviewers receive a separately generated context, validation, and diff package, and AEC-S rejects a review adapter that changes the workspace. A generic command adapter remains a user-registered trusted executable. The MVP does not include containers, multi-host execution, A2A, an AI router, agent scoring, or advanced semantic scope analysis.

Status queries return only each task's latest run and recent events so that front agents do not load full history. The daemon retains the most recent 50,000 rows in the Event table. Complete Run records remain persisted as engineering facts and are not silently deleted.

## Testing

```bash
npm run check
npm run lint
npm test
npm run test:coverage
npm run test:all
```

`test:all` builds once, then runs lint, strict type checking, the dependency-license policy, and thresholded coverage tests (lines 80%, branches 65%, functions 80%). The license policy rejects missing, unknown, copyleft, and otherwise unreviewed dependency licenses. GitHub Actions runs the same gate and a production dependency audit on macOS with Node 26.

Tests cover persistence of all seven entities, scope-conflict analysis, special Git paths, ordinary tasks avoiding full validation, high-risk full validation, same-project concurrency and `HEAD` changes, paused scheduling, independent review, validation/review repair, agent rotation, supervisor recovery, cross-process run/project Git exclusion, timed-out process termination, real calls to all six MCP tools, and an idempotent push/PR/check/repair/merge loop using a fake `gh`.

## License and maintenance

AEC-S was originally developed and is maintained by Aphelion_Lab. It is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may study, modify, and distribute the software for purposes permitted by that license. Redistributions of any part, including modified or integrated versions, must preserve both Required Notices in the [Attribution Notice](NOTICE). Any commercial use requires a separate written commercial license in advance. See [Commercial Licensing](COMMERCIAL-LICENSING.md).

Third-party dependencies are not covered by the AEC-S PolyForm license and remain subject to their respective licenses and attribution requirements. See [Third-Party Notices](THIRD_PARTY_NOTICES.md).

The official repository does not accept external code contributions, pull requests, or code submissions at this stage. See the [Contribution Policy](CONTRIBUTING.md).

AEC-S was originally developed by Aphelion_Lab. Copyright 2026 Aphelion_Lab.
