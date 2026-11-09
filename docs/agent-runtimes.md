# Agent Runtime 接入

Navo 在业务服务与 Agent 引擎之间增加统一 runtime 层。内置 DeepAgents 是默认引擎，已有对话自动归属 `builtin`；内置 Pi Core、Claude Code、DeepSeek Harness、Codex 可以在设置中配置并启用。Pi 直接复用 Navo 的模型、工具和审批，其他外部引擎使用各自的 CLI 配置。

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
| Navo 工具、浏览器、桌面、插件  | 支持            | 支持         | 不接入      | 不接入       | 不接入       |
| 引擎自身工具                   | 支持            | 关闭         | 关闭        | SDK 原生工具 | 只读沙箱工具 |
| Navo 审批与授权                | 支持            | 支持         | 不接入      | 不接入       | 不接入       |
| 直接图片输入                   | 支持            | 按 Navo 模型 | 不支持      | 不支持       | 不支持       |
| 历史重新生成 / checkpoint 分支 | 支持            | 不支持       | 不支持      | 不支持       | 不支持       |

外部引擎遇到需要交互的原生审批时明确拒绝，不自动同意。Pi 的扩展、MCP、Skills、提示模板和工具被关闭；Claude 的工具、MCP 和 Hooks 被关闭；Codex 使用只读沙箱并关闭 MCP、Hooks、插件、浏览器、桌面、子代理等集成。DSH 使用其 SDK 原生工具和审批协议，不继承 Navo 桌面授权。

Pi 和其他运行时都使用项目工作目录，发送时加入项目名称和描述。Pi 的 `read_file`、`write_file`、`edit_file`、`ls`、`grep` 通过 Navo workspace backend 执行，写入会登记为 Navo Artifacts。普通文件附件沿用 Navo 的解析内容快照。外部原生工具生成的文件不会自动登记为 Navo Artifacts。

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
- `external.ts`：归一化显示历史、opaque 会话引用、取消信号与迟到事件隔离。读取历史不启动外部 CLI。
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

测试使用 fake JSONL 子进程和隔离的 SQLite / Electron 用户目录，覆盖流式输出、会话续接、错误、取消、终态后迟到数据、配置快照、草稿、停用及旧 DeepAgents 流程。`pnpm test:e2e:runtimes` 运行真实设置页与聊天页接线测试；没有调用真实外部模型，也没有修改本机 CLI 登录。Windows 和 Linux 的外部进程终止、各 CLI 的真实认证与模型调用需在目标平台另行验收。

### 本轮验收记录（2026-11-09，macOS）

- `pnpm check` 通过：Node/Web 类型检查、ESLint、Prettier、1662 条 i18n 文案、54 个文件中的 489 项单测。
- `pnpm build` 通过，包含 universal desktop helper、浏览器扩展及 Electron 主进程、预加载和 renderer 构建。
- 10 项相关 E2E 通过：`agent-runtimes`、`pi-runtime`、`agent-mock`、`chat-drafts`、`quick`、`projects-artifacts`、`project-home-layout`、`project-workspace-improvements`、`task-lifecycle`、`outputs`、`i18n`。其中项目布局覆盖 1600/1024 宽度及明暗主题。
- Pi Core 专项覆盖 Navo 模型映射、工具桥、workspace 写入、审批暂停、重启恢复、批准/拒绝和取消；四种 Provider 映射及 runtime 回归测试通过。
- 真实 Codex app-server 只验证了 initialize 握手；Pi Core 未调用真实模型。没有执行发行包安装测试或其他平台验收。
