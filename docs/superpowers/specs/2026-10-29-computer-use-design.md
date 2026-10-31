# 电脑操作（Computer Use）设计

日期：2026-10-29 · 状态：待审阅

## 目标

让 Navo 的 Agent 能直接操作用户电脑上已安装的浏览器和软件：

1. **用户自己的浏览器**：在用户日常使用的 Chrome / Edge 等 Chromium 浏览器里干活，用上已登录的账号和插件。
2. **桌面软件**：操作微信、Office、访达、Safari 等任意 App。

成功标准：
- 用户导入扩展后，Agent 能在用户的 Chrome 里新开标签页完成「打开网页 → 读取 → 点击 → 输入」，沿用现有 `browser_*` 工具。
- 授权后，Agent 能在 TextEdit 中新建文档、输入一段中文并保存；非视觉模型（如 DeepSeek）仅靠元素树也能完成。
- 用户随时可按 Esc、移动鼠标或点提示条立即停止。
- 内置浏览器的现有功能与 E2E 全部不受影响。

## 已确定的约束

| 项 | 决定 |
| --- | --- |
| 范围 | 浏览器与桌面一起规划，一份 spec |
| 平台 | 一期只做 macOS 的桌面控制；外部浏览器扩展本身跨平台，但一期只在 macOS 上验证 |
| 授权 | 按 App 授权：每个对话首次操作某 App 时询问一次；控制期间显示提示条；Esc / 鼠标移动急停 |
| 外部浏览器接入 | Navo 浏览器扩展（MV3），使用前引导用户「加载已解压的扩展程序」导入；不上架商店 |
| 桌面控制实现 | 随 App 打包的 Swift 命令行小程序：截屏 + 模拟输入 + 辅助功能（AX）元素树 |
| 模型 | 与提供方无关；截图工具只在模型支持视觉时注册。Anthropic 原生 `computer_*` 工具不在本期 |

## 不做（本期）

- Windows / Linux 的桌面控制（`desktop-service` 的命令协议保持平台无关，留给二期）。
- 浏览器扩展上架 Chrome 应用商店 / Edge 加载项商店。
- 在外部浏览器上运行站点插件、录制宏、固定流程。
- Anthropic 原生 computer use 工具。
- 非 Chromium 浏览器（Safari、Firefox）的 DOM 级控制：它们走桌面控制。

## 架构

```
Agent 进程 ──RPC──► 主进程 tool-registry
                       ├─ browser/tools.ts ──► PageDriver
                       │                         ├─ ElectronPageDriver（内置浏览器，WebContents）
                       │                         └─ ExtensionPageDriver ──WebSocket──► Navo 扩展 ──chrome.debugger──► 用户浏览器标签页
                       └─ desktop/tools.ts ──► desktop-service ──stdin/stdout JSON──► navo-desktop（Swift）
                                                  └─ overlay（提示条、急停）
```

Agent 进程不改：新工具与现有工具一样在主进程执行，经 RPC 代理。

### 单元

#### 1. `src/main/browser/page-driver.ts`（新增）

现有浏览器工具只依赖三类能力：隔离环境执行 JS（`browser.evalIn`）、CDP 命令（`browser.cdp`，点击/输入/截图都是 `Input.*` / `Page.*`）、URL 与标题。抽成接口：

```ts
interface PageDriver {
  id: string                       // 'builtin:<wcId>' | 'ext:<tabId>'
  kind: 'builtin' | 'external'
  url(): string
  title(): string
  evalIn<T>(code: string): Promise<T>
  cdp<T>(method: string, params?: Record<string, unknown>): Promise<T>
  waitForLoad(timeout?: number): Promise<void>
}
```

- `ElectronPageDriver` 包装 `WebContents`，内部调用现有 `browser.evalIn` / `browser.cdp`，行为不变。
- `browser-service` 中 `clickRef`、`typeRef`、`submitRef`、`click`、`hover`、`insertText`、`pressKey`、`scroll`、`screenshot` 改为接收 `PageDriver`。
- `browser/tools.ts` 的 `ToolCtx.tab` 改为返回当前目标的 `PageDriver`；`lastSnap` 以 `driver.id` 为键。
- 内置浏览器专属的逻辑（`sessions.prepare`、`setControlled`、标签页圆点、页面事件）只在 `kind === 'builtin'` 时执行；外部驱动有各自的等价实现（见下）。

#### 2. `extension/`（新增，Navo 浏览器扩展）

MV3 扩展，只做薄转发层，Agent 逻辑全部留在 Navo：

- `manifest.json`：权限 `debugger`、`tabs`、`storage`；`host_permissions` 仅 `ws://127.0.0.1/*`。固定 `key` 以保证扩展 ID 稳定。
- `background.js`（service worker）：
  - 连接 Navo 的本机 WebSocket，断线指数退避重连（上限 10 秒）。保持连接活动使 service worker 不被回收。
  - 处理命令：`tabs.list`、`tabs.create`、`tabs.close`、`tabs.activate`、`debugger.attach`、`debugger.detach`、`cdp.send`；转发 CDP 事件和 `chrome.debugger.onDetach`、`tabs.onRemoved`。
  - 控制中的标签页在扩展图标上显示徽标。
- `popup.html/js`：显示连接状态；「把这个标签页交给 Navo」/「收回」按钮。
- 版本号与 Navo 一致；收到 Navo 的 `reload` 命令时调用 `chrome.runtime.reload()`。
- 构建：`pnpm build:extension` 把 `extension/` 复制到 `out/extension/`，`electron-builder.yml` 的 `extraResources` 打包进 App。

#### 3. `src/main/external-browser/`（新增）

- `bridge.ts`：
  - 在 `127.0.0.1` 开 WebSocket 服务：优先监听 38810，被占用则依次尝试到 38819。扩展无法读取本地文件，因此按同一区间依次尝试连接，以握手消息中的 `app: 'navo'` 确认对方是 Navo。
  - 只接受 `Origin` 为 `chrome-extension://<Navo 扩展 ID>` 的连接。
  - 首次连接时扩展显示 6 位配对码，Navo 弹窗请用户核对确认；确认后双方保存配对令牌（Navo 侧存系统钥匙串），之后自动连接。
  - 请求-响应带 id，单条超时 15 秒。
- `ext-tabs.ts`：
  - `ExtensionPageDriver`：`evalIn` 通过 `Page.createIsolatedWorld`（世界名 `navo-agent`）+ `Runtime.evaluate` 注入并执行现有 `page-runtime.ts`；页面导航后重新创建隔离世界。`cdp` 原样转发。
  - 标签页可用性：Agent 自己创建的标签页直接可用；用户已打开的标签页只有在扩展弹出页点了「交给 Navo」后可用。`browser_tabs` 只列出可用的标签页。
  - 弹窗：订阅 `Page.javascriptDialogOpening`，按与内置浏览器相同的策略用 `Page.handleJavaScriptDialog` 处理，并写入页面事件。
  - 文件上传：`DOM.setFileInputFiles`（需用户在扩展详情中开启「允许访问文件网址」，引导中说明）。
  - 下载：保存在用户浏览器自己的下载目录；工具结果中提示文件名。
- `install.ts`：把打包的扩展复制到 `<userData>/browser-extension/`（固定路径，App 更新不变）；版本变化时覆盖文件并通知已连接的扩展重载。

#### 4. `src/main/desktop/`（新增）

- `helper/`（Swift 源码，Swift Package）编译出 `navo-desktop`（arm64 + x64 universal），放进 `extraResources`，随 App 签名、公证。协议为逐行 JSON：`{"id":1,"cmd":"click","args":{...}}` → `{"id":1,"ok":true,"result":...}`。命令：

  | 命令 | 实现 |
  | --- | --- |
  | `permissions` | `AXIsProcessTrusted`、`CGPreflightScreenCaptureAccess` |
  | `apps` | `NSWorkspace.runningApplications` + `CGWindowListCopyWindowInfo` |
  | `activate` | `NSRunningApplication.activate` / `NSWorkspace.openApplication` |
  | `ax_tree` | `AXUIElement` 遍历前台窗口，返回角色、名称、值、位置、可操作性 |
  | `screenshot` | ScreenCaptureKit 截取窗口，JPEG，长边 ≤ 1568px，返回缩放比 |
  | `click` / `scroll` | `CGEvent` 鼠标事件，或对 AX 元素执行 `AXPress` |
  | `type` | `CGEventKeyboardSetUnicodeString`，不经输入法、不占用剪贴板 |
  | `key` | `CGEvent` 键盘事件，支持组合键 |
  | `window_at` | 屏幕坐标下的窗口所属 App（bundle ID） |
  | `watch_user_input` | 监听真实鼠标移动和 Esc，事件流式上报 |

  注入事件带自定义 `eventSourceUserData` 标记，`watch_user_input` 据此区分 Agent 注入的事件与用户的真实输入。

  `--fake` 模式：返回固定的元素树、截图和权限状态，供测试使用。
- `desktop-service.ts`：启动和守护子进程（崩溃自动重启；单条命令 10 秒超时；连续失败 3 次后本次运行暂停桌面工具）；维护每个对话的元素引用表（`[dN]` → AX 元素路径）；把元素树转成带长度预算的文本，规则与浏览器快照一致；计算两次快照的变化。
- `consent.ts`：按对话 + bundle ID 记录授权；黑名单检查。
- `overlay.ts`：控制期间的提示条和急停。
- `tools.ts`：`desktop_*` 工具。

#### 5. 注册与设置

- `ToolSource` 增加 `'desktop'`；外部浏览器沿用 `'browser'`。
- `collectTools` 在 `Settings.computerUse.desktop` 开启时加入 `desktop_*`；`browser_switch` 在 `Settings.computerUse.myBrowser` 开启时加入。
- `Settings.computerUse = { desktop: boolean, myBrowser: boolean, blockedApps: string[] }`，默认 `{ desktop: false, myBrowser: false, blockedApps: [钥匙串访问, 系统设置, 终端, Navo 的 bundle ID] }`。
- 设置页新增「电脑操作」分区：两个开关、系统权限状态、扩展连接状态与导入引导、黑名单编辑。
- 所有界面文字包在 `t()` 中，并补齐 `en.json`。

## 流程

### 导入扩展

1. 用户第一次开启「使用我的浏览器」，或 Agent 调用 `browser_switch('mine')` 而扩展未连接时，Navo 执行 `install.ts` 把扩展复制到 `<userData>/browser-extension/`，并弹出三步引导：
   1. 在浏览器中打开 `chrome://extensions`（Navo 可用 `open -a <浏览器>` 帮忙打开；`chrome://` 地址无法从外部直接打开时，引导用户复制粘贴）。
   2. 打开右上角「开发者模式」。
   3. 点「加载已解压的扩展程序」，选择该文件夹（提供「在访达中显示」按钮和示意截图）。
2. 扩展加载后自动连接 Navo，引导页跳到配对确认。
3. 引导说明：Chrome 可能在启动时提示「停用开发者模式扩展」，点关闭即可保留。
4. Navo 更新时若扩展版本变化，覆盖文件夹并通知扩展重载，用户无需重新导入。

### 使用用户的浏览器

1. 每个对话有一个当前浏览器目标，默认为内置浏览器。
2. `browser_switch('mine')`：确认扩展已连接 → 在用户浏览器中为该对话新建一个标签页（或使用用户交给 Navo 的标签页）→ 之后的 `browser_*` 都作用在它上面。
3. 首次 `debugger.attach` 时，Chrome 在标签页顶部显示「Navo 已开始调试此浏览器」，这条提示即为控制提示。
4. 对话结束或 `browser_switch('builtin')` 时 detach；Agent 新开的标签页保留，不自动关闭。

### macOS 系统权限

1. 开启桌面控制时，设置页通过 `permissions` 显示「辅助功能」「屏幕录制」两项状态，各带「去授权」按钮，跳转到 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` / `?Privacy_ScreenCapture`。
2. Navo 每 2 秒复查一次，变为已授权后继续。屏幕录制授权后需重启 App，引导提供「重新启动 Navo」按钮（`app.relaunch()`）。
3. 缺少权限时 `desktop_*` 返回：「缺少辅助功能/屏幕录制权限，请到 设置 → 电脑操作 授权」。

### 按 App 授权

1. 触发点：`desktop_activate(app)`，以及任何落在未授权 App 窗口上的点击、输入、按键。
2. 首次触发时，工具调用在主进程内挂起等待用户决定（现有 `interruptOn` 按工具名静态配置，表达不了「按 App」，所以不复用它）：
   - 主进程发出新的 `ChatEvent` `{ type: 'consent'; threadId; request: { id, app, bundleId, icon } }`，对话里显示授权卡片，样式与现有审批卡片一致，选项「本对话允许」「仅这一次」「拒绝」。
   - 用户选择后通过新 IPC `computerUse.consent(id, decision)` 回传，工具调用继续执行或返回「用户拒绝操作 <App>」。
   - Agent 进程到主进程的 `tool.call` RPC 没有超时，挂起不会出错；helper 的 10 秒命令超时只计算 helper 执行时间，不包含等待授权。
   - 运行被中止时，挂起的授权请求自动按拒绝处理并移除卡片。
3. 授权按 `(threadId, bundleId)` 存储；「仅这一次」不存储。
4. 黑名单 App 直接拒绝，不弹审批。
5. 外部浏览器按标签页授权（见「使用用户的浏览器」）。
6. 付款、发送、删除等不可逆操作仍遵循系统提示词中「先向用户确认」的规则。

### 控制提示与急停

1. 桌面控制期间，主进程显示一个置顶、不抢焦点、鼠标可穿透的 `BrowserWindow`（`setIgnoreMouseEvents(true, { forward: true })`，仅「停止」按钮区域可点），文字：「Navo 正在操作 <App> · 按 Esc 停止」。最后一次桌面操作后 3 秒隐藏。
2. 急停触发：
   - Esc：控制期间注册全局快捷键，结束后注销。
   - 真实鼠标移动：`watch_user_input` 报告非 Agent 注入的移动（位移 > 20px）。
   - 点击提示条「停止」。
3. 急停后：调用现有 abort 中止当前运行；helper 释放所有按下的键和鼠标按钮；对话中记录「已被用户中止」。

## 工具

### 外部浏览器

复用现有 `browser_*`，新增一个工具：

- `browser_switch({ target: 'builtin' | 'mine' })`：切换当前对话的浏览器目标，返回目标标签页的 URL 与标题。

外部目标下：
- `browser_tabs` 只列出可用标签页，新建标签页时在用户浏览器中新建。
- `plugin_*`、`macro_*`、固定流程回放返回「请先 `browser_switch('builtin')`」。
- `browser_eval`、`browser_upload_file` 的审批规则不变。

### 桌面

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `desktop_apps` | — | 运行中的 App 与窗口（名称、bundle ID、窗口标题） |
| `desktop_activate` | `app` | 启动或切换到 App；首次触发授权 |
| `desktop_snapshot` | `app?` | 前台窗口元素树，`[dN]` 引用，有长度预算 |
| `desktop_click` | `ref` 或 `x,y`；`button?`、`double?` | 点击元素或坐标 |
| `desktop_type` | `text`、`ref?` | 输入文字（Unicode，支持中文） |
| `desktop_key` | `combo` | 按键 / 组合键，如 `cmd+f`、`enter` |
| `desktop_scroll` | `ref` 或 `x,y`；`dx`、`dy` | 滚动 |
| `desktop_wait_for` | `text`、`timeout?` | 等待窗口中出现文字 |
| `desktop_screenshot` | `app?` | 截取窗口；仅当前模型 `supportsVision` 时注册 |

- 操作类工具返回元素树变化，而非整棵树。
- 坐标以截图坐标为准，helper 按返回的缩放比换算为屏幕坐标（含 Retina）。
- 引用失效时返回「元素 dN 已失效，请重新调用 desktop_snapshot」。
- `desktop_snapshot`、`desktop_screenshot`、`desktop_scroll`、`desktop_wait_for` 加入 `runner.ts` 的 `REPEAT_OK`。

### 系统提示词新增「电脑操作准则」

- 网页任务默认用内置浏览器；需要用户已登录的账号，或用户说「用我的浏览器」时，用 `browser_switch('mine')`。
- Safari、Firefox 和非浏览器 App 用 `desktop_*`。
- 优先用元素引用；元素树读不到时再用截图 + 坐标。
- 在用户的浏览器和 App 里，发送、付款、删除前先确认。

## 错误处理

| 情况 | 处理 |
| --- | --- |
| helper 崩溃 / 无响应 | 自动重启；单条命令 10 秒超时；连续失败 3 次后本次运行暂停桌面工具并告知 Agent |
| 缺少系统权限 | 返回明确错误，Agent 转告用户去设置页授权 |
| 扩展未安装 / 未连接 | `browser_switch('mine')` 返回引导提示，同时界面弹出导入引导 |
| 运行中扩展断开 | 等待 15 秒重连；超时报错。不自动退回内置浏览器 |
| 外部标签页被用户关闭 | 下一次调用返回「标签页已被关闭」 |
| 用户在 Chrome 提示条上取消调试 | 扩展上报 detach，视为用户收回该标签页 |
| 目标窗口不在前台 / 最小化 / 在其他桌面空间 | 操作前自动 activate 并检查窗口；仍不可见则报错 |
| 点击落点所在窗口不属于已授权 App | 每次坐标操作前用 `window_at` 检查归属，不匹配则拒绝并说明 |

## 安全

- 扩展只连接 `127.0.0.1`；Navo 只接受来自 Navo 扩展 Origin 的连接，且需首次配对确认；配对令牌存系统钥匙串。
- 外部浏览器中，Agent 只能使用自己新开或用户明确交出的标签页。
- 桌面控制默认关闭；黑名单 App 不可操作；每个 App 每个对话需授权。
- 截图与元素树仅在本机处理后发给用户配置的模型；Langfuse 沿用 `includeScreenshots` 开关。
- 网页、App 内容中的指令按现有规则视为数据，不作为用户要求。

## 测试

- **单元测试** `tests/computer-use.test.ts`：元素树文本化与预算、树变化计算、截图坐标换算（含 Retina）、授权状态与黑名单、桥接配对与 Origin 校验、`ElectronPageDriver` 与改造前行为一致。
- **回归**：`PageDriver` 改造后 `e2e/tools.mjs`、`flows.mjs`、`monitor.mjs` 及全部现有 E2E 通过。
- **`e2e/my-browser.mjs`**：Playwright 启动加载 Navo 扩展的 Chromium（`--load-extension`），跑配对 → `browser_switch('mine')` → 打开测试页 → snapshot → click → type → extract。可在 Linux CI 运行。
- **`e2e/desktop.mjs`**（macOS）：helper `--fake` 模式，验证工具层、授权审批、急停流程。在 CI 的 macOS 任务运行。
- **`pnpm eval:desktop`**：本机真实控制 TextEdit：新建文档、输入一段中文、保存。需要系统授权，不进 CI。
- **构建**：`scripts/build-desktop-helper.mjs` 编译 universal 二进制，在 `pnpm build` 前执行（非 macOS 跳过）；二进制随 App 签名、公证，`entitlements.mac.plist` 视需要补充。
