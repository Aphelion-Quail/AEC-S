# AEC — Agent Engineering Control

AEC 是一个面向多 Agent 软件工程协作的本地控制平面。Agent 负责推理、实现和审查；AEC 持久化工程状态、隔离工作区、执行权威 Gate，并对 Git/GitHub 副作用进行对账。

当前仓库实现了计划中的完整 MVP：SQLite 状态、不可变 Task DAG、Codex/通用命令 Adapter、worktree 并行、局部验证、独立 Review/Repair、重启恢复、MCP、人类决策入口，以及 GitHub PR/Checks/squash merge。

## 核心不变量

- AEC 是 Task、Run、Agent、Workspace、Validation、Review 与 Decision 控制状态的唯一来源。
- Git 是代码与提交事实来源；GitHub 是 PR、Check 与 Merge 事实来源。AEC 在重试前查询事实。
- 每个 Task 使用独立 worktree。`baseSha` 是来源记录，不是全局锁。
- `HEAD changed` 不会中断运行中的 Agent，也不会直接改变 Task 状态。
- 普通任务只运行项目轻量基线和 Task 明确声明的命令。只有显式要求、Scope 不确定或命中高风险路径时才加入全量命令。
- Reviewer 只接收 Task、约束、Diff 和验证结果，不读取 Executor 对话。
- Front Agent 通过 CLI/MCP 调用 Core，不能直接写 SQLite。

## 环境

- macOS（LaunchAgent 服务只支持 macOS）
- Node.js 26+
- Git
- Codex CLI（执行真实 Agent Task 时）
- GitHub CLI `gh`（使用 GitHub delivery 时）

安装与验证：

```bash
npm install
npm run build
npm test
node dist/src/cli.js doctor
```

默认状态目录是 `~/Library/Application Support/AEC`。可用 `AEC_HOME` 指向独立目录；目录内包含 `aec.db`、Run 日志/Envelope 和 worktree。

## 最短本地闭环

先复制并修改 `examples/` 中的绝对仓库路径、命令和 Scope。本地交付要求 Project 的 `targetBranch` 当前正检出在主仓库中，并且主工作树保持干净；`aec doctor` 会在运行前报告这一条件：

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

任务定义提交后不可修改。方向变化应取消旧 Task，再提交带 `replacesTaskId` 的新 Task。

## 调度与验证

调度只使用角色、required capabilities、availability 和当前 load。默认全局并发为 2，项目并发由 `maxConcurrency` 限制；项目 Git 发布区段始终串行。

两个 Task 只有能证明下列 Scope 无交集时才并行：

```text
A.write ∩ (B.write ∪ B.impact) = ∅
B.write ∩ (A.write ∪ A.impact) = ∅
```

Task 输入必须显式提供 `writeGlobs` 与 `impactGlobs`。空 `writeGlobs` 表示 Scope 无法确定，因此保守串行并触发全量验证；显式空 `impactGlobs` 表示提交者确认没有额外影响范围。Worker 可以在执行期间自由调试和运行探索性测试；AEC 只把下列命令视为权威 Gate：

1. Project `defaultValidation`
2. Task `validationCommands`
3. 条件满足时的 Project `fullValidation`

MVP 的路径模式是一个有意收窄的 glob 子集：`*` 匹配单个路径段内任意字符，`?` 匹配单个非 `/` 字符，`**` 可跨路径段；字符类和花括号不具有扩展语义。所有模式必须是仓库相对路径。无法证明两个模式不相交时，调度器会保守串行。

目标分支在 Task 执行期间变化时，AEC 到发布边界才比较 `oldBase..newBase`。无关变化会复用既有 Validation/Review；相关变化只重跑该 Task 的权威验证和 Review；冲突进入 Repair。

## Daemon 与恢复

同步运行适合调试：

```bash
node dist/src/cli.js run
```

安装用户级 LaunchAgent：

```bash
node dist/src/cli.js service install
node dist/src/cli.js service status
node dist/src/cli.js service restart
```

Agent 与 Validation 命令由独立 job supervisor 执行，输出、最终结果和 PID 都落盘；超时会终止整个子进程组。Daemon 重启后会继续等待存活 job，读取已完成 job，或从最近安全阶段恢复。Run 写入由 lease owner 围栏保护，Agent 并发由数据库原子 slot 控制。Commit、Push、PR 和 Merge 均保存确定性 operation ID；`uncertain` 状态先对账，不盲目重试。

## CLI 控制面

```text
aec project add|list|show|update [...]
aec agent add|list|show|update [...]
aec status [project-id]
aec graph submit <graph.json>
aec directive apply <directive.json>
aec task pause|resume|cancel <task-id>
aec decision list [project-id]
aec decision show <decision-id>
aec decision resolve <decision-id> <resolution.json>
aec decision record <decision.json>
aec doctor
```

Human resolution 示例：

```json
{ "action": "retry_with_agent", "agentId": "codex-executor-2" }
```

系统只有在架构/产品取舍无法由已有 Decision 回答，或允许的 Agent 尝试和轮换耗尽时创建待处理 Decision。

## MCP

stdio server：

```bash
node /absolute/path/to/AEC/dist/src/cli.js mcp
```

提供六个工具：

- `aec_status`
- `aec_submit_task_graph`
- `aec_apply_directive`
- `aec_list_decisions`
- `aec_resolve_decision`
- `aec_record_decision`

一个通用 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "aec": {
      "command": "node",
      "args": ["/absolute/path/to/AEC/dist/src/cli.js", "mcp"],
      "env": { "AEC_HOME": "/absolute/path/to/aec-state" }
    }
  }
}
```

## GitHub delivery

完成 `gh auth login` 并确保目标仓库已配置 branch protection 后，把 Project 的 `deliveryMode` 改为 `github`，同时显式配置非空 `requiredChecks`。流程为：fetch → worktree → validation/review → idempotent commit → force-with-lease push → 创建或复用同一 Task PR → required checks → 使用预期 PR head SHA 自动 squash merge → 清理远端分支。

AEC 不使用 admin merge，也不绕过 branch protection。真实回归仓库应在认证有效且 Human 明确确认后再创建。

## 数据与安全边界

MVP 的七个实体是 Project、Task、Run、Agent、Workspace、Event 和 Decision。Validation、Review、Artifact 路径以及外部 effect 状态保存在 Run 中；Event 仅用于审计，不承担 Event Sourcing。

只注册用户信任的仓库和命令。Git worktree 提供写入隔离，不是安全 Sandbox；Codex Executor/Repair 使用显式 workspace-write 和 workspace cwd，Reviewer 使用 read-only。Reviewer 只获得单独生成的 Context/Validation/Diff 包，AEC 还会拒绝任何修改 workspace 的 Review Adapter；通用 command Adapter 仍属于用户注册的可信执行程序。MVP 不包含容器、多机、A2A、AI Router、Agent 评分或高级语义 Scope 分析。

状态查询只返回每个 Task 的最新 Run 和最近 Event，避免把完整历史装入 Front Agent；Event 表由 Daemon 周期性保留最近 50,000 条。完整 Run 记录仍作为工程事实持久化，不做静默删除。

## 测试

```bash
npm run check
npm run lint
npm test
npm run test:coverage
npm run test:all
```

`test:all` 只构建一次，并依次执行 lint、严格类型检查和带门槛的覆盖率测试（lines 80%、branches 65%、functions 80%）。GitHub Actions 在 macOS/Node 26 上执行同一套 Gate 和生产依赖审计。

测试覆盖七实体持久化、Scope 冲突判断、特殊 Git 路径、普通任务不跑全量验证、高风险全量验证、同项目并行与 HEAD 变化、暂停调度、独立 Review、Validation/Review Repair、Agent 轮换、supervisor 恢复、跨进程 Run/Project Git 互斥、超时进程终止、MCP 六个工具的实际调用，以及通过 fake `gh` 验证 Push/PR/Checks/Repair/Merge 幂等闭环。
