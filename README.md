# AEC-S — Agent Equilibrium Control System

**English** | [简体中文](README.zh-CN.md)

> This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) for noncommercial use only. Redistributions must preserve the [Attribution Notice](NOTICE). See [Commercial Licensing](COMMERCIAL-LICENSING.md) for commercial use.

AEC-S is a local control plane for multi-agent software engineering collaboration. Agents reason, implement, and review; AEC-S persists engineering state, isolates workspaces, enforces authoritative gates, and reconciles Git and GitHub side effects.

This repository is the AEC-S 1.0 release-candidate implementation. Codex, Kimi Code CLI, and DeepSeek Harness are first-class runtimes; the generic command adapter remains available but does not count as heterogeneous scheduling proof. RC2 corrected the live proof boundary and RC3 added the guided first-run path. The version remains `0.9.0-rc.3` until the maintainer-only three-runtime live gate produces a fully passing sanitized report.

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
- Codex CLI
- Kimi Code CLI (AEC-S also searches the official `~/.kimi-code/bin/kimi` location)
- DeepSeek authentication managed by DSH (inherited environment or its owner-only credential store) and the pinned DSH `0.1.0-rc.6` composition
- GitHub CLI `gh` (for GitHub delivery)

Install and verify:

```bash
npm install
npm run build
npm test
npm link
aec-s
node dist/src/cli.js doctor
```

The default state directory is `~/Library/Application Support/AEC-S`. Set `AEC_S_HOME` to use a separate directory. It contains `aec-s.db`, run logs and envelopes, and worktrees.

### Runtime detection

`aec-s init` does not treat “executable found” as “ready.” It reports four independent facts for every Runtime: installation, authentication, SDK/protocol compatibility, and visibility from the AEC-S background process. A successful login is never converted into a “please log in again” message merely because a later compatibility check failed.

For Codex, AEC-S searches `PATH` plus the system and per-user macOS application locations used by ChatGPT.app and Codex.app. A bundled Codex therefore does not require a shell symlink or a manually edited `PATH`.

For Kimi, AEC-S searches `PATH` and `~/.kimi-code/bin/kimi`, checks provider metadata without reading or printing tokens, and then negotiates Runtime capabilities. The primary transport is ACP over stdio through the pinned official ACP TypeScript SDK. The readiness probe exercises initialize, Session create/delete, and load/resume; it separately records negotiated cancel/stream support and the available `plan`/`auto` modes. Actual cancel, streaming, resume, and permissions are exercised by protocol regression tests and the maintainer-only live gate—not overstated as work performed by the readiness probe itself. The older Agent SDK wire remains available only through explicit `transport: "agent_sdk_wire"`; it uses the SDK's automatic execution mode and does not carry ACP's per-tool location permission guarantee. AEC-S never silently changes transport after an ACP failure. `stream-json` prompt mode is diagnostic only, and the generic command Adapter never counts as Kimi.

For DSH, AEC-S verifies every directly pinned `@deepseek-ai/dsh-*` package, asks DSH's own credential seam whether `DEEPSEEK_API_KEY` is configured, and initializes both the Executor and Reviewer compositions over stdio JSON-RPC. The compositions fail closed unless AEC-S supplies `DSH_CWD` and `DSH_SESSION_ROOT`; they never fall back to the daemon working directory. They mount `dsh-credentials-local`, so an authentication already stored by DSH in `$DSH_HOME/.credentials.yaml` is reused without copying the key into AEC-S, SQLite, logs, or the LaunchAgent plist. `dsh web` is an independent product process and is neither required nor adopted as a Run process; AEC-S intentionally launches one isolated headless DSH child per active Run so cancelling one Run cannot affect another.

## First-run system installer

Run `aec-s` with no arguments in a terminal. On first use it opens a keyboard-driven bilingual system installer rather than exposing database paths, plist files, or internal configuration. It asks only for language, installation consent, the optional background-service authorization, Front Agent choice, an optional project directory, Project Intent, and which detected gates are authoritative.

After consent, AEC-S automatically checks macOS, Node.js/npm, Git, GitHub CLI/authentication, Shell/PATH, its data directory, and the callable readiness of Codex, Kimi Code, and DeepSeek Harness. A missing Runtime is reported as `UNAVAILABLE` but never blocks Core installation. Runtime credentials remain owned by their Runtime and are neither copied nor printed.

When authorized, the installer creates the owner-only state tree and SQLite database, registers and starts the user LaunchAgent, verifies Core and MCP health, and performs one bounded automatic restart if the MCP endpoint does not converge. It then offers WorkBuddy, a custom MCP Agent, or skip. WorkBuddy is configured automatically through its CLI when available; custom clients receive the loopback endpoint and owner-only token-file location, never the token value.

Project import detects Git remote and target branch, GitHub, package manager, Node/TypeScript, Flutter, Rust, Go and Python markers, validation candidates, GitHub Actions workflows/Required Checks, and architecture documents. The Human confirms only Intent, delivery direction, and authoritative gates; no `project.json` is required.

The completed boundary is atomically recorded in `$AEC_S_HOME/onboarding.json` without credentials. Later bare `aec-s` executions show the daily Core, service, MCP, Runtime, Front Agent, and Project status instead of rerunning setup. `aec-s init --json` remains available for automation, while the explicit proposal-only import path remains available for advanced use:

```bash
node dist/src/cli.js project import /absolute/path/to/project
```

After the Human confirms Intent and the detected authoritative gates, one explicit command registers the Project:

```bash
node dist/src/cli.js project import /absolute/path/to/project \
  --apply --intent "<project intent>" --accept-detected-gates
node dist/src/cli.js doctor
```

Use `--delivery github` to propose GitHub delivery. Detected workflow job names become Required Check candidates; pass one or more `--required-check <name>` options to override them. A GitHub Project is never registered with an empty Required Check set.

The files in `examples/` remain useful for explicit configuration. Replace the `__AEC_S_REPOSITORY_PATH_REQUIRED__` sentinel, commands, and scopes before using `project add`; both that sentinel and legacy `/absolute/path/to/...` placeholders are rejected. Local delivery requires the project's `targetBranch` to be checked out in the main repository and the main worktree to be clean:

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

Task identity is immutable after submission. Execution assumptions change only through an increasing `TaskRevision`; deterministic Scope Expansion creates a new Revision and recalculates risk and gates. Direction changes still use a replacement Task.

## Scheduling and validation

Scheduling uses only reproducible facts: role and required capabilities, runtime protocol capabilities, health/availability, free slots, normalized load, longest-unassigned time, and stable ID. It never uses model scoring, self-recommendation, or an AI router.

Two tasks run concurrently only when their scopes can be proven disjoint:

```text
A.write ∩ (B.write ∪ B.watch) = ∅
B.write ∩ (A.write ∪ A.watch) = ∅
```

Task input must explicitly provide `writeGlobs` and `watchGlobs`. `impactGlobs` is accepted only as pre-1.0 compatibility input and is never emitted. An empty `writeGlobs` remains conservatively serialized and fully validated. Workers may run exploratory tests; only registered commands are authoritative gates:

1. Project `defaultValidation`
2. Task `validationCommands`
3. Project `fullValidation` when its conditions are met

AEC-S 1.0 intentionally supports a restricted glob subset: `*` matches any characters within one path segment, `?` matches one non-`/` character, and `**` may cross path segments. Character classes and braces have no expansion semantics. Every pattern must be repository-relative. If AEC-S cannot prove two patterns disjoint, it conservatively serializes the tasks.

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

`node dist/src/cli.js daemon` runs the scheduler, durable Outbox delivery, and authenticated HTTP MCP endpoint together in the foreground. `node dist/src/cli.js mcp-http` runs only the HTTP MCP endpoint for diagnostics; the stdio endpoint remains `node dist/src/cli.js mcp`.

Agent and validation commands run under an independent job supervisor. Output, final results, and PIDs are persisted; timeouts terminate the entire child process group. After a daemon restart, AEC-S waits for a live job, consumes a completed job, or resumes from the latest safe phase. Run writes are fenced by lease ownership, and agent concurrency is controlled by atomic database slots. Commit, push, PR, and merge operations use deterministic operation IDs. An `uncertain` operation is reconciled instead of blindly retried.

Child environments are capability-scoped. Git, validation, and ordinary command probes receive only the minimal user, locale, temporary-directory, and executable-path environment; they do not inherit arbitrary daemon secrets. First-class Runtime processes additionally receive only the credential variables required by Codex, Kimi, and DeepSeek Harness. Authenticate GitHub with `gh auth login`; validation commands must not depend on ambient secret variables.

The LaunchAgent stores a stable background `PATH` covering Homebrew, system tools, common user bins, and ChatGPT's bundled Codex by default. Health transitions are debounced: one failure records degradation, while the configured consecutive threshold is required before `unavailable`; recovery is also consecutive. A missing runtime blocks only tasks that require it. Checks, merge, Human input, and stability observation do not occupy runtime capacity.

Ordinary Git, GitHub, validator-launch, and other runtime infrastructure failures use persistent exponential backoff, with five attempts by default. A `failure_exhausted` human decision is created only after retries are exhausted. A nonzero exit after a validation command starts normally remains a code-gate failure and enters repair; failure to launch the command is an operational failure and does not ask an agent to change code.

## CLI control plane

```text
aec-s
aec-s project add|list|show|update [...]
aec-s project import <path> [--json] [--lang en|zh-CN]
  [--apply --intent <text> --accept-detected-gates]
  [--delivery local|github] [--required-check <name> ...]
aec-s agent add|list|show|update [...]
aec-s status [project-id]
aec-s graph submit <graph.json>
aec-s directive apply <directive.json>
aec-s task pause|resume|cancel <task-id>
aec-s decision list [project-id]
aec-s decision show <decision-id>
aec-s decision resolve <decision-id> <resolution.json>
aec-s decision record <decision.json>
aec-s run [task-id]
aec-s daemon
aec-s service install|start|stop|restart|status|uninstall
aec-s doctor
aec-s init [--no-service] [--json] [--lang en|zh-CN]
aec-s mcp
aec-s mcp-http
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

It exposes eleven tools:

- `aec_s_status`
- `aec_s_submit_task_graph`
- `aec_s_apply_directive`
- `aec_s_list_decisions`
- `aec_s_resolve_decision`
- `aec_s_record_decision`
- `aec_s_list_findings`
- `aec_s_transition_finding`
- `aec_s_expand_task_scope`
- `aec_s_poll_outbox`
- `aec_s_acknowledge_outbox`

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

The endpoint listens only on loopback and requires `Authorization: Bearer <token>` on every MCP request. This token is a control-plane capability: a holder can submit validation commands and mutate registered project worktrees inside AEC-S's Seatbelt boundary. It no longer implies unrestricted host-shell access, but it can still change project state and consume local resources. Never share it with an untrusted client, and revoke client access immediately if it may have leaked. `aec-s init` creates the token at `$AEC_S_HOME/mcp-http.token` with mode `0600`; configure it only in a client's secret/header field and never copy it into a repository, log, or task input. Clients that cannot set an HTTP header must use the stdio configuration above. The server keeps at most 64 standard Streamable HTTP sessions, expires idle sessions after 30 minutes, and supports POST, GET/SSE and DELETE termination. Shutdown closes idle keep-alive connections and forcibly bounds remaining connections. Set `AEC_S_MCP_HTTP_PORT` to change the port, then rerun `aec-s service install`. The unauthenticated health endpoint is `http://127.0.0.1:7337/healthz` and deliberately exposes no version. AEC-S is not distributed as an npm package, so do not select npx in the GUI.

Finding transitions do not accept a caller-supplied identity. A dedicated reviewer MCP process must bind an enabled Reviewer with `AEC_S_MCP_ACTOR_AGENT_ID`; the shared daemon endpoint fails closed for this tool when no reviewer identity is bound. Human direction continues through Decision tools rather than impersonating a Reviewer.

WorkBuddy converts natural language into a structured task DAG, directive, or resolution. A minimal escalation integration can periodically call `aec_s_list_decisions(status="pending")`, deduplicate human notifications by decision ID, and return the decision through `aec_s_resolve_decision`. AEC-S does not need chat history as engineering memory.

## GitHub delivery

Run `gh auth login` and configure branch protection on the target repository. Then set the project's `deliveryMode` to `github` and explicitly configure nonempty `requiredChecks`. The flow is: fetch → worktree → validation/review → idempotent commit → force-with-lease push → create or reuse the same task PR → required checks → automatic squash merge using the expected PR head SHA → remote branch cleanup.

AEC-S does not use admin merge or bypass branch protection. Create real regression repositories only after authentication is valid and a human has explicitly confirmed the operation.

## Data and security boundaries

The public model has ten top-level entities: Project, Task, TaskRevision, Run, Agent, Workspace, Finding, Decision, OutboxMessage, and Event. Runtime sessions and health samples remain inside Run and Agent; calibration, gate, and control facts do not become organizational entities.

Register only repositories and commands you trust. AEC-S applies explicit workspace-write/read-only modes to the complete Codex process tree. The inner Codex CLI sandbox is disabled only after that outer kernel boundary is installed, because macOS rejects nested Seatbelt profiles. Kimi Executor Sessions use ACP `auto` mode, grant only one-shot permission responses with complete realpath-confined worktree locations, and persist the Session ID for repair; missing, empty, external, or symlink-escaping locations are rejected. Kimi Review uses `plan` mode and rejects every permission request. DSH Executor uses `workspace-write`; its Reviewer has no file tools and receives only workspace metadata plus the controller-owned review packet, not repository file or Git-object data. Secret-bearing configuration is rejected and known credential formats in Decision resolution, Finding/Scope evidence, Outbox content, Events, and returned state are redacted before persistence; this pattern-based defense does not replace keeping credentials out of task input. Supervised logs, structured results, diffs, Runtime responses, and embedded Reviewer prompts have hard size limits.

Every supervised Runtime and validation process tree also runs inside an AEC-S-owned, deny-by-default macOS Seatbelt profile. It receives an isolated `HOME`/XDG/temp tree, no SSH agent socket or GitHub token, no user/global Git configuration, no AppleEvent authority, and no macOS Keychain service. User-home and per-user temporary data are unreadable except for the exact worktree, read-only controller evidence, AEC-S installation, and the selected Runtime roots. A unique Runtime-output directory is the only writable controller-adjacent tree; JobInput, JobResult, logs, and gate evidence remain controller-owned, and persisted Job input/result records are bound to the same SHA-256 digest. The supervisor maintains a start-time-bound descendant ledger and terminates recorded children even if they detach from the original process group. Credential, policy, and executable paths such as Codex `auth.json`/`config.toml` and Kimi `config.toml`/`bin` remain explicitly non-writable even when a nonstandard Runtime root is configured. Runtime-owned session, database, cache, index, log, telemetry, and atomic state files are writable because current Codex and Kimi versions create dynamic state names. Kimi's trusted ACP process may also atomically refresh its own credential JSON and OAuth lock; Agent-requested paths remain independently confined to the worktree by one-shot ACP permission checks. DSH credential files remain read-only. Executors receive worktree write access, while Reviewers do not. Credential executables found on the active `PATH`, including `gh`, `ssh`, and Keychain helpers, are denied in addition to standard installation paths. AEC-S functionally probes this kernel-enforced boundary before every execution path and marks every Runtime unavailable if it cannot be enforced; it never falls back to advisory environment filtering. Apple deprecates the `sandbox-exec` launcher even though it remains shipped, so removal or protocol drift is an explicit fail-closed compatibility event.

Restricted commands, Validation, and Environment Contract probes run with outbound and inbound networking denied. Codex, Kimi, and DSH receive an explicit `provider` network exception because their controlling process must reach the model service. That exception applies to the Runtime process tree: AEC-S does not currently claim domain-level egress containment for first-class Runtimes, and the pinned Runtime implementation is therefore part of the trusted computing base. Runtime-specific tool policies, worktree realpath checks, read-only Review, and DSH's sandbox still apply, but they are not a substitute for a future brokered model transport or controlled egress proxy.

AEC-S-owned Git commands disable repository hooks and optional filesystem monitors, deny the `ext` transport, and reject repositories whose local configuration declares filters, external diff/text-conversion commands, credential helpers, custom hook paths, or config includes. This prevents repository-controlled Git configuration from becoming an execution path during staging, diffing, commit, worktree creation, or delivery. A Runtime still cannot commit or push: Git metadata is read-only inside Seatbelt and AEC-S rechecks `HEAD` and the final gated diff before publication.

Required Environment Contract components are verified in `prepare`, including registered commands, versions, and Agent capabilities. Registered probe commands run through the persisted job supervisor in the created worktree with read-only filesystem access and no network, rather than in the daemon's unrestricted process context. Scope Calibration and Progressive DAG Parking emit explicit `observe|enforce` policy evidence; an observed Scope Expansion requires a Human Decision before a new Revision is admitted. Drift budgets trigger a bounded synchronization event, and generated files are checked against the Risk Floor again after validation. Deterministic safety invariants remain active in both modes.

A Task becomes `succeeded` only after merge, registered post-merge smoke, and the configured stability observation window. Smoke failure parks local work unless automatic-revert safety is completely proven and explicitly enforced.

Status queries return only each task's latest run and recent events so that front agents do not load full history. The daemon retains the most recent 50,000 rows in the Event table. Complete Run records remain persisted as engineering facts and are not silently deleted.

## Testing

```bash
npm run check
npm run lint
npm test
npm run test:coverage
npm run test:all
npm run test:runtimes:live
```

`test:all` runs lint, strict type checking, license policy, an enforceable package policy, and thresholded coverage. The package policy independently requires every install-script package to match the reviewed `allowScripts` name/version set and checks exact DSH preview pins across production, development, optional, and peer dependencies, so safety does not depend on package-manager defaults. GitHub Actions uses protocol substitutes, immutable release commit pins, and no real credentials. `test:runtimes:live` is maintainer-only, requires `AEC_S_LIVE_RUNTIME_CONFIRM=1`, and verifies the Codex→Kimi, Kimi→DSH, and DSH→Codex strict Review matrix, execute/repair/resume, per-Runtime cancel, Adapter-boundary health debounce, cross-Runtime scheduling, daemon Run recovery, wait-capacity release, and effect reconciliation. It redacts unexpected boundary errors and writes a schema-validated report containing only versions, scenario IDs, PASS/FAIL, time, and schema version.

Tests cover the formal ten-entity projection, Task Revision and Finding evidence, deterministic scheduling and health debounce, scope conflict, validation/review repair, supervisor recovery, post-merge convergence, all eleven MCP tools, and idempotent Git/GitHub effects. The live gate separately proves real Codex/Kimi/DSH execution, review, repair/resume, cancellation isolation, and health thresholds.

## License and maintenance

AEC-S was originally developed and is maintained by Aphelion_Lab. It is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may study, modify, and distribute the software for purposes permitted by that license. Redistributions of any part, including modified or integrated versions, must preserve both Required Notices in the [Attribution Notice](NOTICE). Any commercial use requires a separate written commercial license in advance. See [Commercial Licensing](COMMERCIAL-LICENSING.md).

Third-party dependencies are not covered by the AEC-S PolyForm license and remain subject to their respective licenses and attribution requirements. See [Third-Party Notices](THIRD_PARTY_NOTICES.md).

The official repository does not accept external code contributions, pull requests, or code submissions at this stage. See the [Contribution Policy](CONTRIBUTING.md).

AEC-S was originally developed by Aphelion_Lab. Copyright 2026 Aphelion_Lab.
