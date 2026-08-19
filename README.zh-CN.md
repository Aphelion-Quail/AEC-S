# AEC-S — Agent Equilibrium Control System（智能体均衡控制系统）

[English](README.md) | **简体中文**

> 本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，仅授权非商业用途；另提供[中文参考译文](LICENSE.zh-CN.md)。任何分发均须保留[署名声明](NOTICE)。商业授权请参阅[商业授权说明](COMMERCIAL-LICENSING.zh-CN.md)。

AEC-S 是一个面向多 Agent 软件工程协作的本地控制平面。Agent 负责推理、实现和审查；AEC-S 持久化工程状态、隔离工作区、执行权威 Gate，并对 Git/GitHub 副作用进行对账。

当前仓库是 AEC-S 1.0 的候选发布实现。Codex、Kimi Code CLI 与 DeepSeek Harness 均为一等 Runtime；通用 command Adapter 仍保留，但不计入异构调度证明。版本保持为 `0.9.0-rc.1`，直到维护者本机三 Runtime 真实门禁生成全部通过的脱敏报告。

## 核心不变量

- AEC-S 是 Task、Run、Agent、Workspace、Validation、Review 与 Decision 控制状态的唯一来源。
- Git 是代码与提交事实来源；GitHub 是 PR、Check 与 Merge 事实来源。AEC-S 在重试前查询事实。
- 每个 Task 使用独立 worktree。`baseSha` 是来源记录，不是全局锁。
- `HEAD changed` 不会中断运行中的 Agent，也不会直接改变 Task 状态。
- 普通任务只运行项目轻量基线和 Task 明确声明的命令。只有显式要求、Scope 不确定或命中高风险路径时才加入全量命令。
- Reviewer 只接收 Task、约束、Diff 和验证结果，不读取 Executor 对话。
- Front Agent 通过 CLI/MCP 调用 Core，不能直接写 SQLite。

## 环境

- macOS（LaunchAgent 服务只支持 macOS）
- Node.js 26+
- Git
- Codex CLI
- Kimi Code CLI（AEC-S 同时搜索官方目录 `~/.kimi-code/bin/kimi`）
- 由 DSH 管理的 DeepSeek 认证（继承环境或 DSH 自身的仅属主凭据存储）与锁定为 `0.1.0-rc.6` 的 DSH composition
- GitHub CLI `gh`（使用 GitHub delivery 时）

安装与验证：

```bash
npm install
npm run build
npm test
node dist/src/cli.js init
node dist/src/cli.js doctor
```

默认状态目录是 `~/Library/Application Support/AEC-S`。可用 `AEC_S_HOME` 指向独立目录；目录内包含 `aec-s.db`、Run 日志/Envelope 和 worktree。

### Runtime 探测

`aec-s init` 不会把“找到可执行文件”等同于“可以运行”。它分别报告每个 Runtime 的四项事实：安装、认证、SDK/协议兼容性以及 AEC-S 后台进程可见性。即使后续兼容性检查失败，已经成功的登录也不会被错误转换成“请重新登录”。

对于 Codex，AEC-S 会搜索 `PATH`，以及 ChatGPT.app 和 Codex.app 使用的系统级与用户级 macOS 应用目录。因此，应用内置的 Codex 不要求用户创建 Shell 软链接或手动修改 `PATH`。

对于 Kimi，AEC-S 会同时搜索 `PATH` 和 `~/.kimi-code/bin/kimi`，在不读取或输出 Token 的前提下检查 Provider 元数据，然后协商 Runtime 能力。主控制通道是由锁定版本的官方 ACP TypeScript SDK 驱动的 stdio ACP。就绪探测实际执行 initialize、Session create/delete 与 load/resume，并分别记录协商得到的 cancel/stream 支持及 `plan`/`auto` 模式；真实 cancel、stream、resume 和权限行为由协议回归测试及维护者本机 live gate 验证，不再把“能力广告”表述成探测时已经执行。旧 Agent SDK wire 只能通过显式 `transport: "agent_sdk_wire"` 使用；它采用 SDK 自动执行模式，不具备 ACP 的逐工具位置授权保证。ACP 失败后绝不静默切换 Transport。`stream-json` Prompt 模式仅用于诊断，通用 command Adapter 也不计为 Kimi。

对于 DSH，AEC-S 会验证所有直接锁定的 `@deepseek-ai/dsh-*` 软件包，通过 DSH 自己的 Credential seam 查询 `DEEPSEEK_API_KEY` 是否已配置，并分别对 Executor 与 Reviewer composition 执行 stdio JSON-RPC 初始化。两套 composition 只有在 AEC-S 提供 `DSH_CWD` 与 `DSH_SESSION_ROOT` 时才会启动，绝不回退到 Daemon 工作目录；它们均挂载 `dsh-credentials-local`，因此 DSH 已存入 `$DSH_HOME/.credentials.yaml` 的认证可直接复用，无需把 Key 复制到 AEC-S、SQLite、日志或 LaunchAgent plist。`dsh web` 是独立产品进程，既非运行前提，也不会被接管为 Run 进程；AEC-S 为每个活动 Run 启动隔离的 headless DSH 子进程，确保取消一个 Run 不影响其他 Run。

## 最短本地闭环

先复制 `examples/` 并替换其中的 `__AEC_S_REPOSITORY_PATH_REQUIRED__` 哨兵值、命令和 Scope。`project add` 会在创建任何 Project 前拒绝该哨兵值及旧版 `/absolute/path/to/...` 占位路径。本地交付要求 Project 的 `targetBranch` 当前正检出在主仓库中，并且主工作树保持干净；`aec-s doctor` 会在运行前报告这一条件：

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

Task 身份提交后不可修改；执行假设只通过递增的 `TaskRevision` 改变。确定性的 Scope Expansion 会生成新 Revision，并重新计算 Risk 与 Gate；方向变化仍使用 replacement Task。

## 调度与验证

调度只使用可复现事实：角色与 required capabilities、Runtime 协议能力、健康度/可用性、空闲 slot、归一化 load、最长未分配时间及稳定 ID；不使用模型评分、自我推荐或 AI Router。

两个 Task 只有能证明下列 Scope 无交集时才并行：

```text
A.write ∩ (B.write ∪ B.watch) = ∅
B.write ∩ (A.write ∪ A.watch) = ∅
```

Task 输入必须显式提供 `writeGlobs` 与 `watchGlobs`。`impactGlobs` 只作为 1.0 前输入兼容项接受，输出永不再产生该字段。空 `writeGlobs` 仍会保守串行并执行完整验证；Worker 可运行探索性测试，但只有已注册命令是权威 Gate：

1. Project `defaultValidation`
2. Task `validationCommands`
3. 条件满足时的 Project `fullValidation`

AEC-S 1.0 的路径模式是一个有意收窄的 glob 子集：`*` 匹配单个路径段内任意字符，`?` 匹配单个非 `/` 字符，`**` 可跨路径段；字符类和花括号不具有扩展语义。所有模式必须是仓库相对路径。无法证明两个模式不相交时，调度器会保守串行。

目标分支在 Task 执行期间变化时，AEC-S 到发布边界才比较 `oldBase..newBase`。无关变化会复用既有 Validation/Review；相关变化只重跑该 Task 的权威验证和 Review；冲突进入 Repair。

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

`node dist/src/cli.js daemon` 会在前台一并运行 Scheduler、持久化 Outbox 投递和带认证的 HTTP MCP；`node dist/src/cli.js mcp-http` 仅运行 HTTP MCP，供诊断使用；stdio 端点仍为 `node dist/src/cli.js mcp`。

Agent 与 Validation 命令由独立 job supervisor 执行，输出、最终结果和 PID 都落盘；超时会终止整个子进程组。Daemon 重启后会继续等待存活 job，读取已完成 job，或从最近安全阶段恢复。Run 写入由 lease owner 围栏保护，Agent 并发由数据库原子 slot 控制。Commit、Push、PR 和 Merge 均保存确定性 operation ID；`uncertain` 状态先对账，不盲目重试。

子进程环境按能力隔离。Git、Validation 和普通命令探测只获得最小化的用户、语言区域、临时目录与可执行路径环境，不继承 Daemon 中的任意密钥；一等 Runtime 进程也只额外获得 Codex、Kimi 和 DeepSeek Harness 所需的凭据变量。GitHub 应通过 `gh auth login` 完成认证；Validation 命令不得依赖环境中偶然存在的秘密变量。

LaunchAgent 会保存稳定的后台 `PATH`，默认覆盖 Homebrew、系统工具、常见用户 bin 目录以及 ChatGPT 内置 Codex。健康切换采用防抖：一次失败只记录 degraded 样本，连续失败达到配置阈值后才进入 `unavailable`，恢复也要求连续成功。缺少某个 Runtime 只阻塞依赖它的 Task；等待 Checks、Merge、Human 与稳定性观察不占 Runtime 容量。

普通 Git、GitHub、验证器启动和其他运行期基础设施错误使用持久化指数退避自动恢复，默认最多重试五次；重试耗尽后才创建 `failure_exhausted` Human Decision。验证命令正常启动后的非零退出仍属于代码 Gate 失败，会进入 Repair；命令本身无法启动属于运维失败，不要求 Agent 修改代码。

## CLI 控制面

```text
aec-s project add|list|show|update [...]
aec-s project import <path> [--apply]
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
aec-s init [--no-service]
aec-s mcp
aec-s mcp-http
```

Human resolution 示例：

```json
{ "action": "retry_with_agent", "agentId": "codex-executor-2" }
```

系统只有在架构/产品取舍无法由已有 Decision 回答，或允许的 Agent 尝试和轮换耗尽时创建待处理 Decision。

## MCP

stdio server：

```bash
node /absolute/path/to/AEC-S/dist/src/cli.js mcp
```

提供十一个工具：

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

一个通用 MCP 客户端配置示例：

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

WorkBuddy 桌面版可通过其内置 CLI 添加同一个 stdio server（确保这里的 `AEC_S_HOME` 与 LaunchAgent 完全一致）：

```bash
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy \
  mcp add-json --scope user aec-s \
  '{"type":"stdio","command":"/opt/homebrew/bin/node","args":["/absolute/path/to/AEC-S/dist/src/cli.js","mcp"],"env":{"AEC_S_HOME":"/Users/you/Library/Application Support/AEC-S"}}'

/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy mcp get aec-s
```

如果 WorkBuddy GUI 的连接器只接受 HTTP 或 npx，请使用随 daemon 启动的本机 Streamable HTTP MCP：

```text
http://127.0.0.1:7337/mcp
```

该端点只监听回环地址，并要求每个 MCP 请求携带 `Authorization: Bearer <token>`。该令牌属于控制面能力：持有者可以提交 Validation 命令，并在 AEC-S Seatbelt 边界内修改已注册项目的 worktree。它不再意味着不受限的宿主 Shell 权限，但仍可改变项目状态并消耗本机资源，因此绝不能交给不可信客户端；如怀疑泄露，应立即撤销对应客户端的访问。`aec-s init` 会在 `$AEC_S_HOME/mcp-http.token` 创建权限为 `0600` 的令牌；只应将其配置到客户端的 Secret/Header 字段，绝不能写入仓库、日志或 Task 输入。无法设置 HTTP Header 的客户端必须使用上方 stdio 配置。Server 最多保留 64 个标准 Streamable HTTP Session，空闲 30 分钟后过期，并支持 POST、GET/SSE 和 DELETE 终止；关闭服务时会终止空闲 keep-alive 连接，并为其余连接设置强制收敛边界。可通过 `AEC_S_MCP_HTTP_PORT` 修改端口，随后重新执行 `aec-s service install`。无需认证的健康检查地址为 `http://127.0.0.1:7337/healthz`，且不会暴露版本。AEC-S 不通过 npm 包分发，因此不要在 GUI 中选择 npx。

Finding 状态迁移不再接受调用者自报身份。专用 Reviewer MCP 进程必须用 `AEC_S_MCP_ACTOR_AGENT_ID` 绑定一个已启用 Reviewer；共享 daemon 未绑定 Reviewer 时，该工具默认拒绝。Human 方向仍通过 Decision 工具进入，不冒充 Reviewer。

WorkBuddy 负责把自然语言转换为结构化 Task DAG、Directive 或 Resolution。最小 Escalation 集成可定期调用 `aec_s_list_decisions(status="pending")`，按 Decision ID 去重通知 Human，再通过 `aec_s_resolve_decision` 返回决定；AEC-S 不需要聊天记录作为工程记忆。

## GitHub 交付

完成 `gh auth login` 并确保目标仓库已配置 branch protection 后，把 Project 的 `deliveryMode` 改为 `github`，同时显式配置非空 `requiredChecks`。流程为：fetch → worktree → validation/review → idempotent commit → force-with-lease push → 创建或复用同一 Task PR → required checks → 使用预期 PR head SHA 自动 squash merge → 清理远端分支。

AEC-S 不使用 admin merge，也不绕过 branch protection。真实回归仓库应在认证有效且 Human 明确确认后再创建。

## 数据与安全边界

正式公共模型保留十个顶层实体：Project、Task、TaskRevision、Run、Agent、Workspace、Finding、Decision、OutboxMessage 与 Event。Runtime Session/健康样本保存在 Run/Agent 内，校准、Gate 和控制事实不扩张为组织实体。

只注册用户信任的仓库和命令。Codex 使用显式 workspace-write/read-only。Kimi Executor Session 使用 ACP `auto` 模式，只对位置完整且经 realpath 确认位于 worktree 内的请求签发单次 Permission；位置缺失、为空、在外部或通过符号链接逃逸时一律拒绝，并持久化 Session ID 供 Repair 恢复。Kimi Review 使用 `plan` 模式且拒绝全部 Permission。DSH Executor 使用 `workspace-write`，Reviewer 不挂载文件工具。Secret 配置会被拒绝，Decision Resolution、Finding/Scope 证据、Outbox、Event 与返回状态中的已知凭据格式会在持久化前脱敏；这种模式匹配防线不能替代“不要把凭据写入 Task 输入”。监督日志、结构化结果、Diff、Runtime 响应和内嵌 Reviewer Prompt 均有硬大小上限。

每个受监督 Runtime 与 Validation 进程树还会进入由 AEC-S 持有的 macOS Seatbelt 策略。进程获得隔离的 `HOME`/XDG/临时目录，不继承 SSH Agent Socket、GitHub Token、用户/系统 Git 配置或 macOS Keychain 服务。除精确声明的 worktree、控制器输出目录、AEC-S 安装目录和所选 Runtime 自身状态外，用户主目录和用户临时数据均不可读；Executor 只能写入 worktree、控制器输出、隔离的临时目录/Home 与 Runtime 状态，Reviewer 不获得 worktree 写权限。AEC-S 会对该内核强制边界进行功能探测；一旦无法执行，所有 Runtime 都会标记为不可用，绝不退回仅靠环境变量的建议性限制。Apple 已弃用 `sandbox-exec` 启动器但仍随 macOS 提供，因此其移除或协议漂移会成为明确的 fail-closed 兼容事件。Runtime 必然需要访问自身的模型服务认证状态；该边界阻止的是无关宿主与 Git 权威的继承，而不是阻止 Runtime 使用使其自身可运行的凭据。

Task 要求的 Environment Contract 组件会在 `prepare` 阶段校验注册命令、版本和 Agent 能力。Scope Calibration 与 Progressive DAG Parking 会记录明确的 `observe|enforce` 策略证据；`observe` 下的 Scope Expansion 必须经 Human Decision 才能准入新 Revision。Drift Budget 触发有界同步事件，Validation 生成文件后还会再次检查 Risk Floor。两种模式下，确定性安全不变量始终执行。

Task 只有在 Merge、注册的 post-merge smoke 及稳定性观察窗口全部完成后才进入 `succeeded`。Smoke 失败默认只 Park 局部工作，除非自动回退的全部安全条件已被证明且策略明确为 `enforce`。

状态查询只返回每个 Task 的最新 Run 和最近 Event，避免把完整历史装入 Front Agent；Event 表由 Daemon 周期性保留最近 50,000 条。完整 Run 记录仍作为工程事实持久化，不做静默删除。

## 测试

```bash
npm run check
npm run lint
npm test
npm run test:coverage
npm run test:all
npm run test:runtimes:live
```

`test:all` 执行 lint、严格类型检查、许可证策略、强制包策略与覆盖率门槛。包策略会独立要求所有安装脚本包逐项匹配已审核的 `allowScripts` 名称和版本，并检查生产、开发、可选及 Peer 依赖中的全部 DSH 预发布包是否精确锁定，因此安全性不依赖包管理器默认行为。GitHub Actions 只使用协议级替身、不可变发布提交及无真实凭据环境。`test:runtimes:live` 仅供维护者本机运行，要求 `AEC_S_LIVE_RUNTIME_CONFIRM=1`，会脱敏边界处的意外异常，并只输出版本、场景 ID、PASS/FAIL、时间与报告 Schema 版本。

测试覆盖正式十实体投影、TaskRevision/Finding 证据、确定性调度与健康防抖、Scope 冲突、Validation/Review Repair、supervisor 恢复、合并后收敛、全部十一个 MCP 工具，以及 Git/GitHub 副作用幂等。独立的真实门禁进一步验证 Codex/Kimi/DSH 的执行、Review、Repair/Resume、Cancel 隔离和健康阈值。

## 许可与维护

AEC-S 最初由 Aphelion_Lab 开发并负责维护，并根据 [PolyForm Noncommercial License 1.0.0](LICENSE) 以源代码可用方式发布；[中文译文](LICENSE.zh-CN.md)仅供参考。你可以在该许可证允许的非商业目的范围内学习、修改和分发本软件。分发任何部分（包括修改版本或集成版本）时，必须保留[署名声明](NOTICE)中的两条 Required Notices。任何商业用途均须事先取得单独的书面商业授权，具体方式请参阅[商业授权说明](COMMERCIAL-LICENSING.zh-CN.md)。

第三方依赖不受 AEC-S 的 PolyForm 许可证覆盖，仍分别适用其自身的许可证和署名要求。详情请参阅[第三方软件声明](THIRD_PARTY_NOTICES.zh-CN.md)。

当前阶段，官方仓库不接受外部代码贡献、Pull Request 或代码提交。详情请参阅[贡献政策](CONTRIBUTING.zh-CN.md)。

AEC-S 最初由 Aphelion_Lab 开发。版权所有 © 2026 Aphelion_Lab。
