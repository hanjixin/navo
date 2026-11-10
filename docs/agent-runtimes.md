# Agent Runtime 接入

Navo 在业务服务与 Agent 引擎之间增加统一 runtime 层。内置 DeepAgents 是默认引擎，已有对话自动归属 `builtin`；内置 Pi Core、Claude Code、DeepSeek Harness、Codex 可以在设置中配置并启用。Pi 直接复用 Navo 的模型、工具和审批。Claude/Codex 使用各自 CLI 的模型与认证，通过本轮专属 MCP 桥接 Navo 工具和审批；DSH 保留独立工具模式。

## 使用

1. 对 Claude、DSH、Codex，在本机安装所需 CLI，并按 CLI 自己的方式配置模型和登录。Navo 不安装 CLI，不复制或管理它们的凭据。
2. 打开「设置 → Agent 运行时」。Pi 只需启用；它使用聊天框里选择的 Navo 模型。其他外部运行时填写命令或可执行文件和 JSON 启动参数。
3. DSH 必须填写 Provider 和模型；外部运行时可点击保存后检测 `--version`。Pi 使用 Navo 模型配置，不读取 Pi 本机认证文件。
4. 在新对话、项目新对话或快问的输入框选择运行时，再发送消息。新建按钮先打开草稿，发送成功后创建会话。

启用只代表允许使用，版本检测只代表命令可运行；两者均不证明模型认证、额度或网络正常。启动失败会显示具体错误，并保留尚未进入引擎的消息供用户主动继续。

会话创建时保存运行时配置快照。修改命令、参数、模型等只影响新会话；已有会话不会换引擎。停用后仍能查看历史，后续发送被阻止，已经开始的运行保持其快照。主窗口与快问草稿独立持久保存运行时选择。

## 本版能力

| 能力                           | 内置 DeepAgents | Pi           | Claude Code | DSH          | Codex        |
| ------------------------------ | --------------- | ------------ | ----------- | ------------ | ------------ |
| 文本对话与会话续接             | 支持            | 支持         | 支持        | 支持         | 支持         |
| 增量文本输出                   | 支持            | 支持         | 支持        | 完整消息事件 | 支持         |
| Navo 工具、浏览器、桌面、插件  | 支持            | 支持         | 支持        | 不接入       | 支持         |
| 引擎自身工具                   | 支持            | 关闭         | 关闭        | SDK 原生工具 | 只读沙箱工具 |
| Navo 审批与授权                | 支持            | 支持         | 支持        | 不接入       | 支持         |
| 直接图片输入                   | 支持            | 按 Navo 模型 | 不支持      | 不支持       | 不支持       |
| 历史重新生成 / checkpoint 分支 | 支持            | 不支持       | 不支持      | 不支持       | 不支持       |

Claude 的内建工具、Chrome 集成、slash commands 和 Hooks 被关闭，只加载本次 Navo SDK MCP 服务器。Codex 保留原生只读沙箱，其他本机 MCP、Hooks、插件、原生浏览器、桌面、memory 等集成在本次运行中禁用。Navo MCP 工具独立接受应用的审批和权限校验，不把“原生只读”误认为所有 Navo 工具也只能读取。DSH 原生交互审批继续明确拒绝。

Pi、Claude、Codex 的 `read_file`、`write_file`、`edit_file`、`ls`、`grep` 通过 Navo workspace backend 执行，写入会登记 Artifacts。普通文件附件沿用 Navo 的解析快照；Claude/Codex 目前仍不接受直接图片输入。Codex 原生工具写出的文件不会自动登记为 Navo Artifacts。

### MCP 与审批生命周期

- Claude：`stream-json` 初始化后通过 `control_request/mcp_message` 提供 `initialize`、`tools/list`、`tools/call`；只允许当前工具白名单。每轮重新注入 system prompt，不复用旧项目与记忆指令快照。测试基准为 Claude Code 2.1.307。
- Codex：创建仅监听 `127.0.0.1` 的临时 MCP 端点，以每轮随机 Bearer 认证。令牌只传子进程环境变量，不放到启动参数或持久会话。配置采用深合并，因此先读取已配置 MCP 的名称，在本次 thread 配置中逐个停用，再加入唯一 Navo 端点；不修改用户配置。
- 工具请求经过相同 dispatcher，校验白名单、会话与运行身份，重复请求只执行一次。正文中的 DSML 不属于工具协议，不会被交给执行器。
- 需要审批时保存待确认摘要并返回 `interrupted`，保持原引擎进程和 MCP 请求等待。用户批准、编辑或拒绝后，继续原 `executionId`，使用新 `runId` 调用工具。等待不算完成。
- 停止、进程断线、停用后恢复失败会撤销旧审批并清除界面等待。已进入工具但没有拿到结果时显示“结果未知”，不自动重放。
- **应用重启不能恢复旧 MCP 请求通道**。历史保留，原待确认操作标记中断且旧批准无效，用户需主动重新发送消息；不宣称恢复了原生工具调用栈。

### 统一消息

adapter 将命令、文件操作、MCP 结果和状态转换为 `ToolCall.activity` / `UIMessage`。UI 不解析厂商协议；连续成功操作默认显示最近三项，失败、待确认和未完成项保持可见。命令摘要和目录替代整段协议 JSON。

DSML 出现在普通正文时，流式阶段也会过滤未执行的协议块并显示错误诊断；合法代码示例保留。旧历史在读取时作同样投影，不重写原记录。模型或网关不支持结构化工具调用时会明确失败，不把文字里的 `Bash` 当作授权。

## 架构与扩展点

```text
Chat / Projects / Quick / Tasks
              │
         AgentService
  持久提交、executionId、任务、审批、业务事件
              │
        RuntimeRegistry
  profile 配置、会话绑定、能力查询
              │
        AgentRuntime 接口
         ┌────┴──────────────────┐
  BuiltinRuntimeAdapter   PiRuntimeAdapter   ExternalRuntimeAdapter
    utilityProcess/RPC     Pi Core worker     CLI process/session
         │                       │                    │
  DeepAgents worker       pi-agent-core       Claude / DSH / Codex
```

运行时边界由四个可替换契约组成，业务层只依赖这些契约：

1. **RuntimeAdapter** 负责一次运行的生命周期（启动、停止、状态、恢复和能力声明）。
2. **ModelAdapter** 将 Navo 的 `RuntimeModel` 转换为引擎模型；Provider 不应在聊天页面或 `AgentService` 中分支。
3. **ToolBridge** 只暴露带 `threadId/runId` 的工具调用和 workspace 写入，负责把引擎事件送回主进程并沿用审批隔离。
4. **RuntimeStateStore** 保存引擎私有会话引用和显示历史；每个引擎使用独立 namespace，读取历史不启动引擎进程。

因此新增引擎只需要实现 adapter/driver、模型转换、状态存储和能力声明，再向 Registry 注册；不能把厂商协议、CLI 输出或凭据读取扩散到业务服务和 renderer。`AgentService` 继续拥有 durable submission、`executionId`、审批摘要和任务生命周期，`threadId`、`executionId`、`runId` 也不会被厂商会话 ID 替代。

- `src/main/agent-runtime/contracts.ts`：可序列化运行输入、结果、工具与 usage 契约，不依赖 LangChain 类。旧 `agent-host/protocol.ts` 继续导出同名类型供 worker 兼容。
- `types.ts`：统一 `AgentRuntime` 与外部协议 driver 接口。业务代码不解析厂商消息。
- `contracts.ts`、`tool-bridge.ts`、`state-store.ts`：运行时之间共享的序列化输入、工具桥和状态存储契约；这些接口不得引用 LangChain 或 Electron renderer 类型。
- `registry.ts`：固定五类 profile、配置校验、会话快照、能力查询及进程版本检测。参数不能覆盖适配器管理的会话、协议和权限选项。
- `builtin.ts`：现有 utilityProcess/RPC 封装，旧 worker 事件隔离，停止和删除时处理运行收尾。
- `pi.ts` / `pi-state.ts`：Pi worker 生命周期、SQLite transcript、待审批调用和未知副作用状态。读取历史和审批不启动 worker。
- `external.ts`：归一化历史、opaque 会话引用、串行工具 dispatcher、运行分段与审批等待、取消和迟到事件隔离。读取历史不启动外部 CLI。
- `mcp-tool-bridge.ts` 与 `drivers/claude-mcp.ts`：相同工具 dispatcher 的 HTTP 与 SDK stdio MCP 传输。
- `message-normalizer.ts`：非可执行协议泄漏诊断与增量文本过滤。
- `process.ts`：独占的无 Shell JSONL 进程，单条消息上限、请求超时、错误处理与进程终止。POSIX 上终止自己的进程组。

新增引擎时实现 driver，提供准确能力声明，再注册 profile 与参数校验。厂商会话 ID 保留在主进程，不传给 renderer，也不替代 Navo 的 threadId、executionId 和 runId。

## 数据与 IPC

数据库只追加 `threads.runtime_id`（默认 `builtin`）和 `threads.runtime_config`。Profile 和外部显示历史、会话引用保存在现有 SQLite `kv`；草稿已有 JSON 内容增加 `runtimeId`。不迁移原消息、文件或 DeepAgents checkpoint。

- `runtimes.list`、`runtimes.save`、`runtimes.probe` 与 `runtimes.changed`。
- `threads.create(modelId?, projectId?, runtimeId?)` 和 `chat.submit` 的可选 `runtimeId`。
- `Thread.runtimeId`、草稿保存/迁移中的 `runtimeId`。旧调用不传时使用内置引擎。
- `chat.send`、任务执行、旧的 DeepAgents 工具与审批 API 继续兼容；本版定时任务默认使用内置引擎。

Pi transcript 和待审批状态保存在 Navo SQLite `kv` 中，worker 只在发送或恢复时启动。Claude/Codex/DSH 续接其自身持久会话，DSH 保留本机 `DSH_HOME`，恢复时拒绝使用不同的 home。删除 Navo 对话清理本地显示历史和绑定，不清除外部 CLI 自己管理的历史文件。

## 协议来源与验证边界

实现按 2026-11-09 可核验的协议编写：Pi Coding Agent 官方 RPC 文档（`earendil-works/pi`）、DeepSeek Harness 官方 SDK 协议（`deepseek-ai/deepseek-harness`）、Claude Code CLI 的 print/stream-json 参数，以及 Codex CLI 生成的 app-server JSON Schema。协议发生变化时应更新 driver 与 fixture，不能假定 CLI 命令能启动就表示所有能力兼容。

自动化测试使用 fake JSONL 子进程和隔离的 SQLite / Electron 用户目录，覆盖流式输出、会话续接、错误、取消、终态后迟到数据、配置快照、草稿、停用及旧 DeepAgents 流程。`pnpm test:e2e:runtimes` 运行设置页、聊天页、工具和审批链路测试，不调用付费模型。真实验收通过 `node scripts/runtime-live-smoke.mjs claude|codex /absolute/cli/path` 显式运行：使用本机 CLI 原有认证、隔离的 Navo 数据、本地网页和合成记忆，不复制凭据。Windows 和 Linux 的外部进程终止、各 CLI 的真实认证与模型调用需在目标平台另行验收。

### 本轮验收记录（2026-11-09，macOS）

- `pnpm check` 通过：Node/Web 类型检查、ESLint、Prettier、1662 条 i18n 文案、54 个文件中的 489 项单测。
- `pnpm build` 通过，包含 universal desktop helper、浏览器扩展及 Electron 主进程、预加载和 renderer 构建。
- 10 项相关 E2E 通过：`agent-runtimes`、`pi-runtime`、`agent-mock`、`chat-drafts`、`quick`、`projects-artifacts`、`project-home-layout`、`project-workspace-improvements`、`task-lifecycle`、`outputs`、`i18n`。其中项目布局覆盖 1600/1024 宽度及明暗主题。
- Pi Core 专项覆盖 Navo 模型映射、工具桥、workspace 写入、审批暂停、重启恢复、批准/拒绝和取消；四种 Provider 映射及 runtime 回归测试通过。
- 真实 Codex app-server 只验证了 initialize 握手；Pi Core 未调用真实模型。没有执行发行包安装测试或其他平台验收。

### 2026-11-10 工具桥验收

- 新增双引擎工具 E2E：`node e2e/runtime-tool-bridge.mjs`。实际执行 Navo 记忆、浏览器、文件、审批与 Artifacts，厂商进程协议由 fixture 模拟。包含拒绝、取消、停用、重启旧审批失效和界面清理。
- 真实 Claude 经 Navo 工具桥通过两轮：读取合成记忆、打开本地页面、审批后写文件并登记 Artifacts，下一轮复述两个随机标记。
- 真实 Codex 首次验证发现原生 MCP 准入被 `approvalPolicy=never` 拦截。修正为仅当前 Navo 服务器的明确工具白名单 `approval_mode=approve`，实际审批仍由 Navo 控制；随后两轮真实验证通过记忆、浏览器、审批、文件、Artifacts 和会话续接。
- 不执行打包安装包测试；跨平台验收仍未执行。

- 本轮最终检查：61 个测试文件、570 项单测；Node/Web TypeScript、ESLint、Prettier、i18n（1685 条）通过。编译仅用于运行测试，不生成或验收安装包。
- 真实验收产物分别为隔离测试 profile 的 `workspace/claude-tool-test.txt`、`workspace/codex-tool-test.txt` 和 `live-report.json`，记录实际工具名、流式事件及两轮结果。
