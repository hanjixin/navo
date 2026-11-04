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

首次启动后到「模型」页添加提供方。保存后自动拉取并导入其模型，新增模型默认停用，按需打开每行的启用开关后即可用于对话。重复拉取只补充新模型，保留已有启用状态与自定义配置；也支持手动添加、编辑及连接测试。

支持的提供方：

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

## 界面语言

中文与 English，在「设置 → 外观 → 语言」切换（默认跟随系统），切换后窗口自动重新加载。Agent 用你提问的语言回答。

开发时界面文字写成中文并包在 `t()` 里（`import { t } from '@shared/i18n'`），中文原文即翻译键，英文在 `src/shared/locales/en.json`。`pnpm i18n:check`（已包含在 `pnpm check` 和 CI 中）会检查缺少的翻译、多余的翻译、占位符不一致，以及界面里没有包在 `t()` 中的中文。

## 语音输入

输入框和快问窗口里按住麦克风说话（或点一下开始、再点一下结束，`⌘⇧M` 也可以），松开后文字填进输入框，也可以设为识别后直接发送。识别方式在「设置 → 语音输入」：

- **服务商识别**：任意 OpenAI 兼容服务的 `/audio/transcriptions`，如 OpenAI（gpt-4o-mini-transcribe、whisper-1）、硅基流动（SenseVoice）、Groq。
- **本机识别**：用 [uv](https://docs.astral.sh/uv/) 运行 faster-whisper（whisper-ctranslate2），录音不离开这台电脑；第一次使用会下载识别引擎和模型。

## 国内办公连接器

「连接器」页的「国内办公」：

- **飞书 / 钉钉**：接入官方 MCP（[飞书 OpenAPI MCP](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_installation)、[钉钉 MCP](https://open.dingtalk.com/document/ai-dev/dingtalk-server-api-mcp-overview)），填写开放平台应用的凭证即可，由 Navo 在本机启动（需要 Node.js）。
- **企业微信 / 钉钉 / 飞书群机器人**：填写 Webhook 地址（钉钉「加签」、飞书「签名校验」的密钥可选），Agent 可以往群里发消息，网页监控的提醒也能发到群里。
- **邮箱**：IMAP / SMTP，内置 QQ、163、126、腾讯企业邮箱、阿里企业邮箱、Gmail 的服务器，使用授权码；可以列出、筛选、阅读和发送邮件。
- **日历**：CalDAV（iCloud，以及飞书、钉钉等日历提供的 CalDAV 同步），查看和创建日程。

发消息、发邮件、创建日程，以及飞书 / 钉钉 MCP 里会改动数据的操作，执行前都会请你确认。凭证保存在系统钥匙串。`pnpm check:connectors-live` 用本机的 IMAP / SMTP、CalDAV 测试服务器和官方 MCP 做一次真实检查。

## 产出物

Agent 在 `/workspace/` 写下的文件、在对话标签页里下载的文件，都归到这个对话的「产出」里（对话顶部的「产出 N」）。可以直接预览 Markdown、HTML、CSV / Excel 表格、图片、PDF 与 Office 文档，并导出：Markdown → Word / PDF，CSV、JSON 记录或 Markdown 里的表格 → Excel；也可以另存、在访达中显示。Agent 也能用 `export_file` 工具直接交付 Word / PDF / Excel。

## 项目工作区

侧栏只保留一个项目分组：点击分组标题进入项目总览，点击旁边的加号新建项目，下方直接打开最近项目；收起侧栏时保留一个项目总览图标。详情分为「对话」「Artifacts」「项目设置」：可以直接发送任务创建项目内对话、继续历史会话、集中查看产物，以及修改项目名称和背景描述。侧栏可展开最近会话，显示运行和待确认状态，展开状态会在本机保存。

项目详情采用三栏布局：左侧为项目导航，中间为当前工作内容，右侧默认展示文件树，可切换「文件 / 产物 / 浏览器」，项目说明在折叠资料区查看。产物可按文件名和类型筛选，点击后在右侧预览、导出或返回来源会话；文件、产物预览和浏览器共用可调宽度的右侧面板，统一支持收起和恢复；窄屏通过可关闭的抽屉访问。项目、会话、详情页签和选中产物都有可恢复的地址，支持刷新和前进后退。

项目为可选项：从「全部会话」新建的对话不归属任何项目。会话可以移动到其他项目或取消归属，产物随之更新；删除项目会保留其对话与产物，运行中的会话继续执行。新建或编辑项目时可以选择本地工作目录；项目内的 `/workspace/` 映射到该目录，可读取已有文件并保存产物。不选目录时使用 Navo 默认工作区。切换目录不移动已有文件，历史产物保留原位置；正在运行或等待审批的任务沿用本轮开始时的目录。目录失效会明确报错，不会悄悄切回默认目录。产物索引按成功写入或下载的来源会话记录。

右侧「文件」可以浏览当前工作目录中的已有文件，并直接选择或更换目录；默认共享目录、空目录和不可用目录有不同的状态提示。支持展开文件夹、隐藏文件开关、预览前后文件、路径导航、复制路径及打开系统文件管理器。返回列表会恢复展开和滚动位置，外部修改文件后返回应用会自动刷新，也可手动刷新。浏览不会上传文件，也不会把已有文件登记为 Agent 产物；「项目产物」仍显示对话生成和下载的文件。

开发验证：构建后运行 `node e2e/projects-artifacts.mjs`，覆盖项目详情、并发产物归属、会话移动、预览导出、路由恢复与删除恢复。`node e2e/project-files.mjs` 验证已有文件浏览、预览刷新、目录切换和路径边界；`node e2e/project-workspace-improvements.mjs` 验证导航去重、直接绑定目录、连续预览、聚焦刷新及窄屏关闭与焦点恢复。

## 用量与费用

每次调用模型（对话及子 Agent、记忆提取与整理、Skill 复盘、流程整理、网页监控的判断）都会记录 token 用量和用途。在「模型」页给模型设置单价（常见模型有参考价），「用量」页按天、按用途、按模型、按对话展示 token 和估算费用。可以设每日预算：用完时提醒，并可选择暂停后台调用（对话不受影响）。

## 网页监控

「任务」里新建「网页监控」：网址、关注的内容、可选的页面区域（CSS 选择器）、触发条件（如「价格低于 1500」「出现新的公告」，留空则有实质变化就提醒）、检查频率。每次检查在后台标签页读取页面文字：**内容没变不调用模型**；有变化才用一次模型判断是否满足条件，并写一句变化摘要。满足时发送系统通知，也可以让 Agent 接着执行一项任务。「记录」里可以看到每次检查、变化内容的差异和触发记录；连续失败会提醒。

## 固定流程（不依赖模型的重复任务）

Agent 靠模型摸索着在某个系统（常见是老旧的内部系统）上完成一次操作后，对话顶部的「固化流程」会把它的浏览器操作整理成固定流程：用稳定的选择器定位元素（不依赖每次都变的 id），每次会变的值（单号、日期等）成为参数，密码不保存、运行时填写。任务说得像以后还要做（「每天」「以后」…）时会主动提示。

之后在「任务」里新建「固定流程」类型的任务，定时在后台标签页直接回放，不调用模型。页面改版导致某一步失效时，Agent 从失败处接手完成，并用它的操作更新流程（记一个新版本，可回滚）；「录制宏」页显示回放次数、自动修复次数与版本记录。

## 开发

### 电脑操作

「设置 → 电脑操作」可以开启浏览器扩展或桌面应用控制。桌面控制支持 macOS 14+、Windows 10/11 的普通交互桌面，默认关闭；Linux 暂不支持：

- macOS：点击「辅助功能 → 前往授权」，在系统设置中允许 Navo 读取控件、点击和输入。开发模式下系统可能显示 Electron 或桌面 helper；以系统申请提示为准。
- macOS：使用窗口截图时还需要「屏幕录制」权限；仅使用元素树的模型无需这项权限。授权后如仍提示未授权，点击「重新启动 Navo」。
- Windows：无需 macOS 的辅助功能或屏幕录制授权；仍需在 Navo 内批准目标应用。只控制当前用户、同等权限的普通窗口，不支持 UAC 安全桌面、管理员权限窗口、锁屏或其他登录会话。
- 首次操作每个 App 时选择「本对话允许」「仅这一次」或「拒绝」。macOS 默认禁止系统设置、钥匙串、终端和 Navo；Windows 默认禁止系统设置、cmd.exe、PowerShell 与当前 Navo 主进程路径。其他终端（包括 Windows Terminal）可在设置中按可执行文件路径补充禁用。
- 控制期间有独立置顶提示条；真实键盘输入、鼠标按下、滚轮、拖动、移动鼠标超过 20 像素或点击停止都会中止当前运行。Agent 自己注入的事件不会触发接管，一次只允许一个对话控制桌面。

桌面工具包含应用列表、启动/切换、元素树、点击、Unicode 输入、组合键、滚动、等待与截图。截图工具仅向支持视觉的模型提供；坐标使用最近截图内的像素。每次快照刷新元素引用，旧引用失效。输入同时绑定快照/截图中的窗口 ID、进程和边界；窗口切换、移动或操作结果不确定时，需要重新观察，失败的点击或输入不会自动重放。等待文本在原始元素树匹配，不受显示预算和转义影响。

浏览器扩展中的标签页由对话独占。用户收回标签页或取消 Chrome 调试横幅后，旧控制对象和正在等待的操作立即失效；新授权不会恢复旧请求。断线时会释放实际调试连接，旧连接的响应不能完成新连接的请求。正常续聊可重新获取仍获授权、未被占用的原标签页。扩展脚本即使版本号未变，只要随应用的内容有更新也会同步。

macOS 开发需要 Xcode Command Line Tools（`xcode-select --install`）。`pnpm dev` 自动编译本机架构的 Swift helper，`pnpm build` / `pnpm dist` 编译 arm64 + x86_64。Windows 开发需要 .NET 10 SDK，`pnpm dev` 发布本机架构 helper，`pnpm build` / `pnpm dist` 发布 win-x64 与 win-arm64；安装包按目标架构携带完整 self-contained 运行时，用户无需安装 .NET。Linux 构建跳过桌面 helper。

本机测试系统权限请运行 `pnpm dist:local:mac`，生成完整 ad-hoc 签名的 App，并检查 App 与 helper 的签名和标识。每次输出到独立的 `release/local-mac/build-*/mac*/Navo.app`，不覆盖正在运行的本地包或正式发布目录；正式 `pnpm dist` 的签名、公证策略不变。此命令只构建，不启动或申请权限。

从 Finder 双击新包，或使用脚本打印的 `open "…/Navo.app"` 命令经 LaunchServices 启动，再在 Navo 设置中申请辅助功能和屏幕录制权限。不要通过 Playwright、直接执行 `Contents/MacOS/Navo` 或终端运行 helper 来验证打包 App 的权限，以免系统将权限归属到测试器或终端。先退出旧 Navo，确认打开的是刚构建的路径。

ad-hoc 签名不能在代码变化后保证旧授权继续有效。重建后若权限开关已开但仍无法操作，请退出 Navo，在系统设置的辅助功能和屏幕录制列表中移除旧 Navo 条目，再添加新包并重新授权，最后通过 Finder 或 `open` 重启。helper 使用固定签名标识 `com.navo.desktop`，App 使用 `com.navo.app`；固定标识不代表代码变化后免于重新授权。本地 ad-hoc 包仅用于本机测试，分发仍使用正式证书与公证流程。

`pnpm test:desktop` 使用隔离配置和 helper 的 `--fake` 模式验证授权与工具链路，不操作真实桌面。Windows CI 配置了原生 helper 构建、协议回归和 Electron 桌面 E2E；自动化结果不等同于 Windows 实机、多屏、不同 DPI、UAC 或各应用 UI Automation 兼容性验证，发布前仍需在 Windows 实机完成这些验证。`pnpm eval:desktop` 显示本机测试说明；macOS 授予系统权限后运行 `node scripts/desktop-eval.mjs --run`，在 TextEdit 新建文档并输入中文，验证元素树、截图和坐标。加 `--stop-test` 可手动验证 Esc 急停。测试文档会保留为未保存状态。

开发环境、脚本、目录结构与提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。CI（`.github/workflows/ci.yml`）在每个 PR 上运行类型检查、Lint、格式检查、单元测试、构建，并在 macOS 上跑端到端测试和打包冒烟测试，在 Windows 上跑桌面 helper 与 Electron E2E；推送 `v*` 标签触发三平台发布。

E2E 使用 `AB_USER_DATA` 指定的临时配置目录，不影响本机数据。

真实模型评测（使用你「模型」页里的默认模型，在配置的临时副本上运行，会产生少量调用费用）：

- `pnpm eval:memory`：自动学习记忆的质量（该记的、不该记的、投毒、更新/删除）。
- `pnpm eval:agent`：7 个浏览器任务（比价、填表、翻页、弹窗、长文、下拉、表格），在本地测试网站上运行。
- `pnpm eval:monitor`：网页监控的判断（满足 / 不满足条件、无关变化、页面里夹带的指令）。
- `pnpm eval:flow`：固定流程全过程——在本地「老旧 ERP」上靠模型完成一次 → 固化 → 无模型回放 → 改版后回放失败、Agent 修复 → 修复后的流程再无模型回放。

## 发布

`pnpm dist` 在本机打包；推送 `v*` 标签由 `.github/workflows/release.yml` 在三个平台构建并创建 GitHub 草稿发布。

macOS 要让别人能正常打开，需要签名和公证：

| 用途                 | 需要                                                                                          | 本机                                                                    | GitHub Secrets                             |
| -------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| 签名                 | Apple 开发者计划的 **Developer ID Application** 证书（「Apple Development」证书只能本机调试） | 装进钥匙串即可                                                          | `MAC_CERT_P12_BASE64`、`MAC_CERT_PASSWORD` |
| 公证                 | Apple ID + App 专用密码 + Team ID                                                             | 设置环境变量 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | 同名 Secrets                               |
| Windows 签名（可选） | 代码签名证书                                                                                  | —                                                                       | `WIN_CERT_PFX_BASE64`、`WIN_CERT_PASSWORD` |

没有配置时照常打包，只是跳过签名 / 公证（构建日志会提示）；这样的安装包在别的 Mac 上需要右键「打开」才能运行。
