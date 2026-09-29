<p align="center"><img src="resources/logo.svg" width="72" alt="Navo"></p>

<h1 align="center">Navo</h1>
<p align="center">会自己上网干活的桌面 AI 助手 · 领航你的浏览器</p>

基于 **LangChain deepagents (JS)** 的桌面 Agent 客户端：内置可被 Agent 控制的浏览器，支持对话、任务、Skill、连接器、MCP、长期记忆、站点 DOM 插件与操作录制宏。

Electron 44 · electron-vite · React 19 · Tailwind v4 · shadcn 风格组件（radix-ui）· better-sqlite3

## 快速开始

```bash
pnpm install          # postinstall 会为 Electron 重编译 better-sqlite3
pnpm dev              # 开发模式
pnpm dist             # 打包（mac dmg / win nsis / linux AppImage）
```

首次启动后到「模型」页添加提供方：

| 类型                      | 说明                                                |
| ------------------------- | --------------------------------------------------- |
| Anthropic                 | Claude，Messages API                                |
| OpenAI · Chat Completions | `/v1/chat/completions`                              |
| OpenAI · Responses        | `/v1/responses`（`useResponsesApi`，支持推理强度）  |
| OpenAI 兼容接口           | DeepSeek / 通义 / Ollama / vLLM 等，自定义 Base URL |

API Key 通过 Electron `safeStorage`（系统钥匙串）加密，仅主进程可读。

## 界面与快捷键

| 操作                | 方式                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| 展开 / 收起左侧导航 | `⌘B`（Windows `Ctrl+B`）或标题栏按钮；窗口宽度 < 1240px 时自动收起为图标栏                    |
| 打开 / 收起浏览器   | `⌘\` 或标题栏右侧按钮                                                                         |
| 调整浏览器宽度      | 拖动浏览器左侧分隔条；双击恢复 560px；拖到最窄继续拖动后松开即收起；聚焦分隔条后可用 ← → 调整 |
| 对话列表            | 对话标题栏按钮切换；内容区较窄时自动隐藏                                                      |

手动切换后以你的选择为准（保存在本地）；内容区始终保留至少 440px，浏览器面板会优先让出空间。

## 架构

```
Renderer (React)  ──typed IPC──►  Main 进程（工具宿主）                 ──RPC──►  Agent 进程（utilityProcess）
  pages / stores                     BrowserService  标签页、CDP、下载、弹窗          deepagents 运行循环
  browser-panel ◄─ bounds ─►         agent-session   对话↔标签页、页面弹窗接管          SqliteSaver checkpoint
                                     plugins / recorder / mcp / connectors            模型调用、运行轨迹
                                     tool-registry   为每次运行收集工具 ◄── tool.call ── 代理工具 (JSON Schema)
```

- **Agent 在独立进程运行**（`src/main/agent-host`）：长任务不会卡住界面；进程崩溃会自动重启。浏览器、插件、宏、MCP、连接器工具由主进程执行，Agent 进程通过 RPC 调用。
- **每个对话独占一个标签页**：并发运行的对话互不干扰，标签页上的圆点表示正在被哪个对话使用。
- **页面快照有预算**：默认只含正文的当前屏和下一屏，导航/页脚链接折叠；操作类工具只返回页面变化。配合循环检测（相同调用重复会被拦截）和旧工具结果清理，控制上下文长度与成本。
- **页面弹窗**：Agent 操作时 `alert/confirm/prompt` 不会阻塞页面，结果写入工具返回的「页面事件」；确认框默认取消，需要时用 `browser_set_dialog_policy`。文件选择框被拦截后由 `browser_upload_file` 完成；下载自动保存到「下载」文件夹；登录类弹窗保留为真实窗口。
- **Agent 文件系统**（`CompositeBackend`）：`/memories/`、`/skills/`、`/workspace/` 落盘；`/ext/*` 为 `~/.agents/skills` 等外部 Skill 的只读挂载。
- **安全**：API Key、OAuth token、MCP 环境变量与请求头均用系统钥匙串（safeStorage）加密；每个站点插件运行在独立的隔离环境中。
- **可观测性**：在「设置 → 可观测性」配置 [Langfuse](https://langfuse.com)（Cloud EU/US 或自建）后，每次 Agent 运行都会上报为一条 Trace（模型调用、工具调用、Token、耗时），同一对话归为同一个 Session；截图默认不上传。对话标题栏的「Trace」按钮可直接跳转。开发者模式下还有本地运行轨迹，并可选 LangSmith。

## 编写站点插件

`<userData>/plugins/<id>/manifest.json`：

```json
{
  "id": "hacker-news",
  "name": "Hacker News",
  "matches": ["https://news.ycombinator.com/*"],
  "contentScript": "content.js",
  "actions": [{ "name": "list_stories", "description": "列出文章", "parameters": { "type": "object", "properties": { "limit": { "type": "number" } } } }]
}
```

`content.js` 在隔离环境中运行，可直接操作 DOM：

```js
agentPlugin.register('list_stories', async ({ limit = 30 } = {}) =>
  [...document.querySelectorAll('tr.athing')].slice(0, limit).map((r) => r.querySelector('.titleline > a')?.textContent),
)
```

打开匹配网站时，动作自动成为 `plugin_hacker_news_list_stories` 工具。可在「站点插件」页编辑、热重载并在当前页试运行。

## 录制宏

浏览器工具栏或「录制宏」页点击录制 → 在右侧浏览器操作 → 停止。步骤可编辑、重排；在值中写 `{{name}}` 即成为参数。开启「作为 Agent 工具」后以 `macro_*` 暴露；回放失败可一键交给 Agent 继续；也可导出为 Skill。

## 开发

开发环境、脚本、目录结构与提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。CI（`.github/workflows/ci.yml`）在每个 PR 上运行类型检查、Lint、格式检查、单元测试、构建，并在 macOS 上跑端到端测试和打包冒烟测试；推送 `v*` 标签触发三平台发布。

E2E 使用 `AB_USER_DATA` 指定的临时配置目录，不影响本机数据。
