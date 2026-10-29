# 电脑操作（Computer Use）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Navo 的 Agent 通过 Navo 浏览器扩展操作用户自己的 Chromium 浏览器，并通过随 App 打包的 Swift 小程序操作 macOS 上的任意 App。

**Architecture:** 浏览器工具改为面向 `PageDriver` 接口，内置浏览器（`WebContents`）和外部浏览器（扩展经 WebSocket 转发 `chrome.debugger`）各有一个实现，现有 `browser_*` 工具与 `page-runtime.ts` 原样复用。桌面控制由主进程守护的 `navo-desktop` 子进程（逐行 JSON）完成截屏、AX 元素树和 CGEvent 输入；主进程负责 `[dN]` 引用、按 App 授权、提示条与急停。Agent 进程只改 `REPEAT_OK`。

**Tech Stack:** Electron 44 · TypeScript · zod 4 · `ws`（新增依赖）· Chrome MV3 扩展（纯 JS）· Swift 5.9+（AppKit / ApplicationServices / ScreenCaptureKit）· vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-10-29-computer-use-design.md`

## Global Constraints

- 桌面控制只做 macOS；非 macOS 上 `desktop_*` 不注册，`scripts/build-desktop-helper.mjs` 直接跳过。
- 两项功能默认关闭：`Settings.computerUse = { desktop: false, myBrowser: false, blockedApps: [...] }`。
- 默认黑名单 bundle ID：`com.apple.keychainaccess`、`com.apple.systempreferences`、`com.apple.Terminal`、`com.navo.app`，开发环境另加 `com.github.Electron`。
- 扩展桥接只监听 `127.0.0.1`，端口 38810–38819 依次尝试；只接受 `Origin: chrome-extension://<EXTENSION_ID>`；握手消息带 `app: 'navo'`。
- 桥接单条请求超时 15 秒；运行中扩展断开后最多等 15 秒重连；扩展断线重连退避上限 10 秒。
- helper 单条命令超时 10 秒（不含等待用户授权）；连续失败 3 次后本次运行暂停桌面工具。
- 截图长边 ≤ 1568px，JPEG 质量 70；提示条在最后一次桌面操作 3 秒后隐藏；真实鼠标位移 > 20pt 触发急停；权限状态每 2 秒复查。
- 外部浏览器下 `plugin_*`、`macro_*` 返回「请先 browser_switch('builtin')」；运行中扩展断开不自动退回内置浏览器。
- 所有界面文字中文原文包在 `t()` 中并补齐 `src/shared/locales/en.json`，`pnpm i18n:check` 通过。
- 每个任务结束时 `pnpm typecheck && pnpm lint && pnpm test` 通过；动到浏览器层的任务还要跑 `pnpm test:e2e`。
- 提交信息遵循 conventional commits，末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 生成物（helper 二进制、打包后的扩展）放在已被 `.gitignore` 忽略的 `dist/` 下：`dist/bin/navo-desktop`、`dist/extension/`。

## Review Focus

1. **用户手搭在触控板上的轻微抖动、以及 Agent 自己注入的鼠标移动**：不应触发急停；用户真实移动超过 20pt 应立即停止。→ Task 10 `StopWatcher` 测试。
2. **Agent 自己调用 `desktop_key('escape')`**：不应被 Esc 急停快捷键当成用户按键。→ Task 10 `shouldStopOnEsc` 测试。
3. **没截过图、或截图后窗口被移动，再用坐标点击**：应拒绝并要求重新截图，而不是点到别处。→ Task 8 `toScreen` / `checkShot` 测试。
4. **授权卡片还在等待时用户点了「停止」**：卡片消失，工具返回拒绝，运行正常结束不挂起。→ Task 9 `cancel` 测试。
5. **Chrome 回收了扩展的 service worker（调试会话随之断开）后 Agent 继续操作**：重连后自动重新 attach 并重建隔离环境，继续用同一个标签页。→ Task 4 重连测试。

---

## File Structure

```
extension/                               Navo 浏览器扩展源码（纯 JS，MV3）
  manifest.json  background.js  popup.html  popup.js  icons/
scripts/
  gen-extension-key.mjs                  一次性生成 manifest key
  build-extension.mjs                    extension/ → dist/extension/，写入版本号
  build-desktop-helper.mjs               swift build → dist/bin/navo-desktop
  desktop-eval.mjs                       pnpm eval:desktop（真实控制 TextEdit）
src/shared/
  extension.ts                           EXTENSION_ID、BRIDGE_PORTS、extensionIdFromKey
  types.ts                               + ComputerUseSettings、ConsentRequest、ConsentDecision、ComputerUseStatus、ChatEvent 新成员
  ipc-contract.ts                        + computerUse.* 方法与事件
src/main/browser/
  page-driver.ts                         PageDriver 接口 + builtinDriver(wc)
  browser-service.ts / tools.ts / agent-session.ts   改为面向 PageDriver
src/main/external-browser/
  protocol.ts                            扩展 ↔ Navo 消息类型
  bridge.ts                              WebSocket 服务、Origin 校验、配对、请求/事件
  ext-tabs.ts                            ExternalPageDriver、ExtTabs（可用标签页）
  targets.ts                             每个对话的当前浏览器目标
  install.ts                             扩展复制到 userData、版本更新
  tools.ts                               browser_switch
src/main/desktop/
  helper/                                Swift Package（navo-desktop）
  protocol.ts                            helper 命令与结果类型
  helper-process.ts                      子进程守护、超时
  ax-text.ts                             元素树文本化、RefTable、diffTree、toScreen
  desktop-service.ts                     每个对话的当前 App、快照、操作
  consent.ts                             按 App 授权
  stop-watch.ts                          StopWatcher、shouldStopOnEsc
  overlay.ts                             提示条窗口与急停
  tools.ts                               desktop_* 工具
src/main/computer-use.ts                 汇总：状态、IPC 处理、endRun
src/renderer/src/components/settings/computer-use-section.tsx
src/renderer/src/components/browser/extension-guide.tsx    导入引导 + 配对确认
src/renderer/src/components/chat/consent-card.tsx
src/renderer/src/pages/control-overlay.tsx
tests/page-driver.test.ts  tests/ext-bridge.test.ts  tests/ext-driver.test.ts  tests/ext-install.test.ts
tests/desktop-helper.test.ts  tests/desktop.test.ts  tests/consent.test.ts  tests/stop-watch.test.ts
e2e/my-browser.mjs  e2e/desktop.mjs
```

---
## 阶段一：浏览器层改为 PageDriver（行为不变）

### Task 1: PageDriver 接口与内置浏览器实现

**Files:**
- Create: `src/main/browser/page-driver.ts`
- Modify: `src/main/browser/browser-service.ts:17`（导出 `RUNTIME_SRC`）、`:505-573`（`clickRef`…`screenshot` 改收 `PageDriver`）
- Modify: `src/main/browser/agent-session.ts:12-20`（导出 `DIALOG_SHIM`、`RESTORE`），`:176-210`（抽出 `dialogNotice`、`chooserNotice`）
- Modify: `src/main/browser/tools.ts`（全部改为面向 `PageDriver`）
- Modify: `src/main/recorder/recorder-service.ts:160-191`（用 `builtinDriver(wc)` 包一层）
- Test: `tests/page-driver.test.ts`

**Interfaces:**
- Produces（`page-driver.ts`）：
  ```ts
  export type CdpFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  export interface DialogPolicy { confirm: boolean; prompt: string | null }
  export interface PageDriver {
    readonly id: string                 // 'builtin:<wc.id>' | 'ext:<tabId>'
    readonly kind: 'builtin' | 'external'
    url(): string
    title(): string
    evalIn<T = unknown>(code: string): Promise<T>     // agent 隔离环境，page-runtime 已就位
    evalMain<T = unknown>(script: string): Promise<T> // 页面主环境（browser_eval）
    cdp: CdpFn
    navigate(url: string): Promise<void>              // 内部做 normalizeUrl
    history(action: 'back' | 'forward'): Promise<boolean>  // false = 无法后退/前进
    waitForLoad(timeout?: number): Promise<void>
    prepare(): Promise<void>            // 每次工具操作前：弹窗接管、控制标记
    bringToFront(): Promise<void>       // 截图前
    takeNotices(): string[]
    chooser(): { backendNodeId: number } | null
    clearChooser(): void
    setDialogPolicy(p: DialogPolicy): Promise<void>
  }
  export function builtinDriver(wc: WebContents, opts?: { agent?: boolean }): PageDriver
  ```
- Produces（`agent-session.ts`）：`export const DIALOG_SHIM: string`、`export const RESTORE: string`、`export function dialogNotice(consoleMessage: string): string | null`（非 `__navo_dialog__` 前缀或 JSON 坏掉返回 null）、`export function chooserNotice(mode: string): string`。
- Produces（`browser-service.ts`）：`export const RUNTIME_SRC`；`clickRef(p: PageDriver, ref, opts?)`、`typeRef(p, ref, text, clear?)`、`submitRef(p, ref)`、`click(p, x, y, opts?)`、`hover(p, x, y)`、`insertText(p, text)`、`pressKey(p, key)`、`scroll(p, dx, dy)`、`screenshot(p, fullPage?)`。`evalIn(wc)`、`cdp(wc)`、`waitForLoad(wc)` 保持接收 `WebContents`。
- Produces（`tools.ts`）：`ToolCtx` 增加可选 `page?: () => PageDriver`；`export function pageOf(ctx: ToolCtx): PageDriver`（有 `page` 用它，否则 `builtinDriver(ctx.tab(), { agent: !!(ctx.threadId || ctx.sandbox) })`）。

- [ ] **Step 1: 写失败的测试** `tests/page-driver.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { dialogNotice, chooserNotice } from '../src/main/browser/agent-session'

describe('dialogNotice', () => {
  const m = (o: object) => '__navo_dialog__' + JSON.stringify(o)
  it('describes each dialog kind and its outcome', () => {
    expect(dialogNotice(m({ type: 'alert', message: '已保存', answer: null }))).toBe('页面弹出提示框：「已保存」，已关闭')
    expect(dialogNotice(m({ type: 'confirm', message: '删除？', answer: false }))).toContain('已自动选择「取消」')
    expect(dialogNotice(m({ type: 'confirm', message: '删除？', answer: false }))).toContain('browser_set_dialog_policy')
    expect(dialogNotice(m({ type: 'prompt', message: '名字', answer: 'Ada' }))).toContain('已填写「Ada」')
  })
  it('ignores other console output', () => {
    expect(dialogNotice('hello')).toBeNull()
    expect(dialogNotice('__navo_dialog__{bad')).toBeNull()
  })
  it('chooserNotice mentions multi-select', () => {
    expect(chooserNotice('selectMultiple')).toContain('可多选')
    expect(chooserNotice('selectSingle')).toContain('单选')
  })
})
```

`agent-session.ts` 会通过 `browser-service` 间接 import `electron`；若 vitest 加载失败，把 `DIALOG_SHIM`、`RESTORE`、`dialogNotice`、`chooserNotice` 放进新文件 `src/main/browser/dialogs.ts`（无 electron 依赖），`agent-session.ts` 从那里 import，测试也改为从 `dialogs.ts` import。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run tests/page-driver.test.ts`
Expected: FAIL，`dialogNotice is not exported`

- [ ] **Step 3: 抽出 `dialogNotice` / `chooserNotice`**，文案与 `agent-session.ts:176-207` 现有拼法逐字一致，`listen` 里的两个回调改为调用它们。

- [ ] **Step 4: 实现 `page-driver.ts` 的 `builtinDriver`**：每个方法委托给现有代码——`evalIn`→`browser.evalIn(wc)`；`evalMain`→`wc.executeJavaScript('(async () => { ${script} })()', true)`；`navigate`→`browser.navigate(url, wc)`；`history` 用 `wc.navigationHistory`；`prepare` 等于现在 `onTab` 里的 `sessions.prepare(wc)`（仅 `agent`）+ `browser.setControlled(wc, true)`；`bringToFront` 等于现在截图前的 `browser.activate(wc.id)`；`takeNotices/chooser/clearChooser/setDialogPolicy` 委托 `sessions`。用 `WeakMap<WebContents, PageDriver>` 缓存，同一个 `wc` 返回同一个对象。

- [ ] **Step 5: 改 `browser-service.ts` 的输入辅助函数**为接收 `PageDriver`（内部 `this.evalIn(wc, …)` → `p.evalIn(…)`，`this.cdp(wc, …)` → `p.cdp(…)`），`routed` 同样改。`recorder-service.ts` 调用处改为 `browser.clickRef(builtinDriver(wc), ref)` 等。

- [ ] **Step 6: 改 `tools.ts`**：`onTab` 改名 `onPage(ctx, fn: (p: PageDriver) => Promise<T>)`，调用 `p.prepare()`；`header`、`snapshotBody`、`fullSnapshot`、`changes`、`targetOf`、`withNotices` 改收 `PageDriver`；`lastSnap` 以 `p.id` 为键。`browser_tabs`、`browser_downloads` 暂不改（Task 4 处理）。`trace.add(...)` 只在 `p.kind === 'builtin'` 时记录。

- [ ] **Step 7: 运行单测与回归**

Run: `pnpm vitest run tests/page-driver.test.ts && pnpm typecheck && pnpm test:e2e`
Expected: 单测 PASS；E2E 全部 `PASS`、没有 `FAIL` 行（`tools.mjs`、`flows.mjs`、`monitor.mjs` 是重点）

- [ ] **Step 8: Commit**

```bash
git add src/main/browser src/main/recorder tests/page-driver.test.ts
git commit -m "refactor(browser): tools drive a PageDriver instead of WebContents"
```

---
## 阶段二：使用用户的浏览器

### Task 2: Navo 浏览器扩展

**Files:**
- Create: `extension/manifest.json`、`extension/background.js`、`extension/popup.html`、`extension/popup.js`、`extension/icons/{16,48,128}.png`（由 `resources/icon.png` 缩放）
- Create: `scripts/gen-extension-key.mjs`、`scripts/build-extension.mjs`
- Create: `src/shared/extension.ts`
- Modify: `package.json`（`"build": "node scripts/build-extension.mjs && electron-vite build"`，新增 `"build:extension"`）、`electron-builder.yml`（`extraResources` 加 `from: dist/extension, to: extension`）、`eslint.config.js`（`extension/**` 用 browser + `chrome` 全局变量）
- Test: `tests/ext-bridge.test.ts`（本任务只放 ID 测试，Task 3 继续加）

**Interfaces:**
- Produces（`src/shared/extension.ts`）：`export const EXTENSION_ID: string`、`export const BRIDGE_PORTS: number[]`（38810…38819）、`export function extensionIdFromKey(base64Der: string): string`。
- Produces（线上协议，Task 3 的 `protocol.ts` 用 TS 写同一份；扩展侧是手写 JS，两边以这里为准）：
  - 扩展 → Navo：`{ t: 'hello', version: string, browser: string, token: string | null }`、`{ t: 'res', id: number, ok: true, result } | { t: 'res', id, ok: false, error: string }`、`{ t: 'evt', name, payload }`、`{ t: 'pong' }`
  - Navo → 扩展：`{ t: 'welcome', app: 'navo', paired: boolean }`、`{ t: 'pair', code: string }`、`{ t: 'paired', token: string }`、`{ t: 'busy' }`、`{ t: 'req', id: number, method, params }`、`{ t: 'ping' }`
  - 请求 `method`：`tabs.list` → `{ tabId, url, title, active }[]`；`tabs.create {url}` → `{ tabId, url, title }`；`tabs.close {tabId}`；`tabs.activate {tabId}`；`debugger.attach {tabId}`；`debugger.detach {tabId}`；`cdp.send {tabId, method, params}` → CDP 结果；`ext.reload`
  - 事件 `name`：`cdp {tabId, method, params}`、`detached {tabId, reason}`、`tabRemoved {tabId}`、`tabUpdated {tabId, url, title}`、`handover {tabId, url, title}`、`revoke {tabId}`

- [ ] **Step 1: 生成 manifest key**：写 `scripts/gen-extension-key.mjs`（`crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })`，导出 SPKI DER 的 base64，写进 `extension/manifest.json` 的 `key`，私钥丢弃：加载已解压扩展只需要公钥来固定 ID）。运行一次并提交 manifest。

- [ ] **Step 2: 写失败的测试**（`tests/ext-bridge.test.ts`）

```ts
import manifest from '../extension/manifest.json'
import { EXTENSION_ID, extensionIdFromKey, BRIDGE_PORTS } from '../src/shared/extension'

it('extension id is derived from the manifest key', () => {
  expect(extensionIdFromKey(manifest.key)).toBe(EXTENSION_ID)
  expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/)
  expect(BRIDGE_PORTS).toEqual([38810, 38811, 38812, 38813, 38814, 38815, 38816, 38817, 38818, 38819])
})
```

- [ ] **Step 3: 运行，确认失败**：`pnpm vitest run tests/ext-bridge.test.ts` → FAIL（模块不存在）

- [ ] **Step 4: 实现 `extensionIdFromKey`**：SHA-256(DER 字节) 取前 16 字节的十六进制，每个字符 `0-f` 映射为 `a-p`。把算出的值写成 `EXTENSION_ID` 常量。`src/shared` 也会被 renderer 引用，所以用 `node:crypto` 的部分只能在测试和主进程里调用；如果 `tsconfig.web.json` 报错，把 `extensionIdFromKey` 移到 `scripts/` 与测试共用的 `src/main/external-browser/extension-id.ts`，`src/shared/extension.ts` 只保留常量。

- [ ] **Step 5: 写 `manifest.json`**：`manifest_version: 3`，`name: "Navo"`，`permissions: ["debugger", "tabs", "storage", "alarms"]`（`alarms` 用于 service worker 被回收后每分钟唤醒重连；spec 未列出，属于必要补充），`host_permissions: ["ws://127.0.0.1/*"]`，`background.service_worker: "background.js"`，`action.default_popup: "popup.html"`，`version` 由构建脚本写入。

- [ ] **Step 6: 写 `background.js`**：
  - `connect()`：依次尝试 `ws://127.0.0.1:<port>`，收到 `welcome` 且 `app === 'navo'` 才算连上，否则换下一个端口；全部失败时按 1s、2s、4s… 退避，上限 10 秒。`onStartup`、`onInstalled` 和每分钟的 `alarms` 都调用 `connect()`（已连接则跳过）。
  - 连上后发 `hello`（`token` 来自 `chrome.storage.local`，`browser` 取 `navigator.userAgentData.brands` 中第一个非 `Chromium`/`Not` 的品牌）。收到 `pair` 存到内存供弹出页显示并设徽标 `?`；收到 `paired` 把 token 存进 `chrome.storage.local`。
  - 处理 `req` 的各个 `method`；`chrome.debugger.onEvent` → `evt cdp`；`onDetach` → `evt detached` 并清徽标；`tabs.onRemoved` / `tabs.onUpdated`（`url` 或 `title` 变化时）→ 对应事件。attach 成功后给该标签页设徽标文字 `AI`。
  - 收到 `ping` 回 `pong`（Navo 每 20 秒发一次，保持 service worker 活着）。
  - 「交给 Navo」的标签页 ID 存 `chrome.storage.session` 的 `handed`。
- [ ] **Step 7: 写 `popup.html/js`**：显示连接状态（未连接 / 等待配对 + 6 位码 / 已连接 + 浏览器名）；当前标签页的「把这个标签页交给 Navo」/「收回」按钮，分别发 `handover` / `revoke` 事件。扩展界面文字只有中文，不走 `t()`（扩展不在 i18n 检查范围内，`scripts/i18n-check.mjs` 若扫到 `extension/` 则排除该目录）。

- [ ] **Step 8: 写 `scripts/build-extension.mjs`**：把 `extension/` 复制到 `dist/extension/`，`manifest.version` 设为 `package.json` 的 `version`。

- [ ] **Step 9: 验证**

Run: `pnpm vitest run tests/ext-bridge.test.ts && pnpm build:extension && node -e "console.log(require('./dist/extension/manifest.json').version)"`
Expected: 测试 PASS；打印 `0.1.0`

- [ ] **Step 10: Commit**

```bash
git add extension scripts/gen-extension-key.mjs scripts/build-extension.mjs src/shared/extension.ts tests/ext-bridge.test.ts package.json electron-builder.yml eslint.config.js
git commit -m "feat(extension): Navo browser extension that relays CDP to Navo"
```

---
### Task 3: 扩展桥接（WebSocket、Origin 校验、配对）

**Files:**
- Create: `src/main/external-browser/protocol.ts`、`src/main/external-browser/bridge.ts`
- Modify: `package.json`（`pnpm add -D ws @types/ws`；主进程依赖由 electron-vite 打包，放 devDependencies 与现有依赖一致）
- Test: `tests/ext-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 的线上协议、`EXTENSION_ID`、`BRIDGE_PORTS`。
- Produces（`protocol.ts`）：`ExtMethod`、`ExtEventName`、`ExtToNavo`、`NavoToExt` 联合类型。
- Produces（`bridge.ts`）：
  ```ts
  export interface Link {
    readonly browser: string
    request<T = unknown>(method: ExtMethod, params?: Record<string, unknown>): Promise<T>
    on(name: ExtEventName, fn: (payload: any) => void): () => void
    readonly closed: boolean
  }
  export interface BridgeStatus { connected: boolean; paired: boolean; browser: string | null; pairingCode: string | null }
  export interface BridgeOptions {
    ports: number[]; extensionId: string
    tokens: { get(): string | null; set(token: string): void }
    timeoutMs?: number  // 默认 15000
    pingMs?: number     // 默认 20000
  }
  export class Bridge {
    constructor(opts: BridgeOptions)
    start(): Promise<number>          // 返回实际监听的端口
    stop(): Promise<void>
    link(): Link | null               // 已配对的当前连接
    waitForLink(ms: number): Promise<Link | null>
    status(): BridgeStatus
    confirmPairing(approve: boolean): void
    onChange(fn: (s: BridgeStatus) => void): () => void
  }
  export const bridge: Bridge  // BRIDGE_PORTS、EXTENSION_ID、tokens 存 secrets 'extension.token'
  ```

- [ ] **Step 1: 写失败的测试**（追加到 `tests/ext-bridge.test.ts`，用 `ws` 客户端模拟扩展，端口用 `[39810, 39811]` 避开真实端口）

```ts
describe('Bridge', () => {
  // helper: connect(origin) 打开 WebSocket，返回 { ws, next(): Promise<msg> }
  it('rejects connections from another origin', async () => {
    // origin 'chrome-extension://aaaa…' → 连接被拒（'unexpected-response' 403 或 close）
  })
  it('pairs a new extension after the user confirms the code', async () => {
    // 发 hello(token:null) → 收到 welcome{app:'navo',paired:false} 和 pair{code}
    // expect(code).toMatch(/^\d{6}$/); expect(bridge.status().pairingCode).toBe(code)
    // bridge.confirmPairing(true) → 收到 paired{token}; tokens.set 被调用且参数等于该 token
    // expect(bridge.status()).toMatchObject({ connected: true, paired: true, pairingCode: null })
  })
  it('a rejected pairing closes the connection', async () => {
    // hello(token:null) → pair; bridge.confirmPairing(false) → 客户端收到 close; tokens.set 未被调用; status().connected === false
  })
  it('a known token is paired at once', async () => {
    // tokens.get() 返回 'T1'; hello(token:'T1') → welcome{paired:true}, 没有 pair 消息; bridge.link() 不为 null
  })
  it('a wrong token asks to pair again', async () => {
    // tokens.get() 返回 'T1'; hello(token:'T2') → welcome{paired:false} + pair{code}; bridge.link() === null
  })
  it('round-trips a request and times out a silent one', async () => {
    // timeoutMs: 50；link.request('tabs.list') → 客户端收到 req，回 res{ok:true,result:[]} → resolve []
    // 不回复的请求 → reject，message 含 '超时'
    // 回复 ok:false,error:'x' → reject 'x'
  })
  it('turns away a second extension while one is linked', async () => {
    // 第二个已配对连接收到 { t: 'busy' } 并被关闭；第一个仍是 link()
  })
  it('falls back to the next port when the first is taken', async () => {
    // 先用 net.createServer 占住 39810，start() 返回 39811
  })
  it('forwards events and drops the link on close', async () => {
    // 客户端发 evt cdp → on('cdp') 收到 payload；ws.close() → link.closed === true, status().connected === false
  })
})
```

每个用例写出完整的 `expect`，上面注释即断言内容。

- [ ] **Step 2: 运行，确认失败**：`pnpm vitest run tests/ext-bridge.test.ts` → FAIL（`Bridge` 不存在）

- [ ] **Step 3: 实现 `Bridge`**：`new WebSocketServer({ host: '127.0.0.1', port, verifyClient })`，`verifyClient` 检查 `origin === 'chrome-extension://' + extensionId`；`EADDRINUSE` 时试下一个端口。配对码 `crypto.randomInt(0, 1e6)` 补零到 6 位；token 为 `crypto.randomBytes(32).toString('hex')`，比较用 `timingSafeEqual`。同一时刻只有一个已配对连接；未配对的连接 60 秒内没确认就关闭。每 `pingMs` 发 `ping`。

- [ ] **Step 4: 运行测试**：`pnpm vitest run tests/ext-bridge.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/external-browser/protocol.ts src/main/external-browser/bridge.ts tests/ext-bridge.test.ts package.json pnpm-lock.yaml
git commit -m "feat(my-browser): local bridge the extension pairs with"
```

---
### Task 4: 外部标签页驱动（ExternalPageDriver、ExtTabs）

**Files:**
- Create: `src/main/external-browser/ext-tabs.ts`
- Test: `tests/ext-driver.test.ts`

**Interfaces:**
- Consumes: `PageDriver`、`DialogPolicy`（Task 1）；`RUNTIME_SRC`、`normalizeUrl`（`browser-service.ts`）；`DIALOG_SHIM`、`dialogNotice`、`chooserNotice`（Task 1）；`Link`（Task 3）。
- Produces：
  ```ts
  export type GetLink = (waitMs: number) => Promise<Link | null>
  export interface ExtTabInfo { tabId: number; url: string; title: string; owned: boolean }
  export class ExternalPageDriver implements PageDriver {   // id = 'ext:<tabId>', kind = 'external'
    readonly tabId: number
    detach(): Promise<void>
  }
  export class ExtTabs {
    constructor(getLink: GetLink)
    create(url?: string): Promise<ExternalPageDriver>   // owned
    list(): Promise<ExtTabInfo[]>                       // 只含可用标签页（owned 或 handed）
    handed(): ExtTabInfo[]                              // 用户交给 Navo、按交出时间倒序
    driver(tabId: number): ExternalPageDriver           // 不可用时抛「这个标签页没有交给 Navo」
    close(tabId: number): Promise<void>
    downloads(): { filename: string; url: string }[]    // 最近 10 个
  }
  export const extTabs: ExtTabs   // getLink = (ms) => bridge.link() ? Promise.resolve(bridge.link()) : bridge.waitForLink(ms)
  ```

- [ ] **Step 1: 写失败的测试** `tests/ext-driver.test.ts`。写一个 `fakeLink()`：记录 `request(method, params)`，按 method 返回预设结果（`tabs.create` → `{tabId: 7, url, title: ''}`；`cdp.send` 的 `Page.getFrameTree` → `{ frameTree: { frame: { id: 'F1' } } }`；`Page.createIsolatedWorld` → `{ executionContextId: ++n }`；`Runtime.evaluate` → `{ result: { value: 42 } }`），并能 `emit(name, payload)`、`close()`。

```ts
it('evaluates in a navo-agent isolated world, created once per document', async () => {
  const link = fakeLink(); const tabs = new ExtTabs(async () => link)
  const p = await tabs.create('https://a.test')
  expect(await p.evalIn('1')).toBe(42)
  await p.evalIn('2')
  const worlds = link.cdpCalls('Page.createIsolatedWorld')
  expect(worlds).toHaveLength(1)
  expect(worlds[0]).toMatchObject({ frameId: 'F1', worldName: 'navo-agent' })
  const ev = link.cdpCalls('Runtime.evaluate').at(-1)
  expect(ev).toMatchObject({ contextId: 1, awaitPromise: true, returnByValue: true })
  expect(ev.expression).toContain('return (2)')
  link.emit('cdp', { tabId: 7, method: 'Page.frameNavigated', params: { frame: { id: 'F1' } } })
  await p.evalIn('3')
  expect(link.cdpCalls('Page.createIsolatedWorld')).toHaveLength(2)
})
it('turns exceptionDetails into an error', async () => {
  // Runtime.evaluate 返回 { exceptionDetails: { exception: { description: 'Error: 元素 e3 已失效' } } } → rejects '元素 e3 已失效'
})
it('lists only tabs the agent opened or the user handed over', async () => {
  // tabs.list 返回 7(owned)、8、9；emit handover {tabId: 9}
  // expect((await tabs.list()).map(t => t.tabId)).toEqual([7, 9]); expect(() => tabs.driver(8)).toThrow('没有交给 Navo')
  // emit revoke {tabId: 9} → list 只剩 7
})
it('reports a closed tab and a cancelled debugging session', async () => {
  // emit tabRemoved {tabId:7} → p.evalIn rejects '标签页已被关闭'
  // 另一个标签页 emit detached {tabId, reason:'canceled_by_user'} → rejects '取消了调试'
})
it('reattaches after the extension reconnects', async () => {
  // link1.close(); getLink 第二次返回 link2；p.evalIn('1') 成功
  // link2 上依次出现 debugger.attach {tabId:7}、Page.createIsolatedWorld
})
it('fails after waiting when the extension stays away', async () => {
  // link.close(); getLink 返回 null → rejects '与浏览器扩展的连接已断开'
})
it('takes over dialogs and file choosers', async () => {
  // await p.prepare(): cdpCalls 含 Page.enable、Runtime.enable、Page.addScriptToEvaluateOnNewDocument{source: DIALOG_SHIM}、Page.setInterceptFileChooserDialog{enabled:true}
  // emit cdp Runtime.consoleAPICalled { args: [{ value: '__navo_dialog__{"type":"alert","message":"hi","answer":null}' }] } → p.takeNotices() 等于 ['页面弹出提示框：「hi」，已关闭']
  // emit cdp Page.fileChooserOpened { backendNodeId: 5, mode: 'selectSingle' } → p.chooser() 等于 { backendNodeId: 5 }，takeNotices 含 chooserNotice('selectSingle')
  // emit cdp Page.downloadWillBegin { suggestedFilename: 'a.pdf', url: 'https://a.test/a.pdf' } → notices 含 'a.pdf'，tabs.downloads()[0].filename === 'a.pdf'
})
```

- [ ] **Step 2: 运行，确认失败**：`pnpm vitest run tests/ext-driver.test.ts` → FAIL

- [ ] **Step 3: 实现 `ExternalPageDriver`**：
  - 每个调用先 `ensure()`：取 link（断开时 `getLink(15000)`），link 变了就清空 attach、隔离环境和 prepare 状态；未 attach 则 `debugger.attach`。标签页已关闭、被取消调试时直接抛对应错误。
  - `evalIn`：用与内置浏览器相同的包装 `` `(async () => { ${RUNTIME_SRC} return (${code}); })()` ``；上下文失效（错误含 `Cannot find context`）时重建一次再试。`evalMain`：同样的 `Runtime.evaluate`，不传 `contextId`，表达式为 `` `(async () => { ${script} })()` ``。
  - `url()`/`title()` 返回缓存值，来源为 `tabs.create` 结果、`tabUpdated` 事件、主框架的 `Page.frameNavigated`。
  - `navigate`：`Page.navigate { url: normalizeUrl(url) }`；`waitForLoad`：每 200ms `Runtime.evaluate('document.readyState')`，`complete` 或超时（默认 15000）返回；`history`：`Page.getNavigationHistory` + `Page.navigateToHistoryEntry`。
  - `prepare`：只做一次（link 重连后重做），内容见测试；弹窗沿用内置浏览器的 `DIALOG_SHIM` 和策略（`window.__navoDialogPolicy`），文档变化时重新应用策略。另外订阅 `Page.javascriptDialogOpening` 作为兜底（shim 拦不住的弹窗），按策略 `Page.handleJavaScriptDialog`。
  - `bringToFront`：`tabs.activate` + `Page.bringToFront`。

- [ ] **Step 4: 实现 `ExtTabs`**：`owned`、`handed`（含时间）两个集合，订阅 `handover`/`revoke`/`tabRemoved`；`list` 用 `tabs.list` 结果过滤；下载记录来自各驱动的 `Page.downloadWillBegin`。

- [ ] **Step 5: 运行测试**：`pnpm vitest run tests/ext-driver.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/external-browser/ext-tabs.ts tests/ext-driver.test.ts
git commit -m "feat(my-browser): page driver for tabs in the user's browser"
```

---
### Task 5: 浏览器目标切换与工具接入（browser_switch）

**Files:**
- Create: `src/main/external-browser/targets.ts`、`src/main/external-browser/tools.ts`、`src/main/computer-use.ts`
- Modify: `src/shared/types.ts`（`Settings.computerUse`、`ComputerUseSettings`、`ComputerUseStatus`）
- Modify: `src/main/core/settings.ts:7-31`（默认值）、`:39-53`（合并 `computerUse`）
- Modify: `src/shared/ipc-contract.ts`（`computerUse.status`、`computerUse.confirmPairing`；事件 `computerUse.changed`、`computerUse.guide`）、`src/main/handlers.ts`
- Modify: `src/main/browser/tools.ts`（`browser_tabs`、`browser_downloads` 的外部分支；`activeTabCtx` 加 `page`）
- Modify: `src/main/agent/tool-registry.ts`（注册 `browser_switch`；外部目标下拦截 `plugin_*`、`macro_*`；`systemPrompt` 签名与「电脑操作准则」）
- Modify: `src/main/agent/agent-service.ts:255-305`（`ctx.page`、systemPrompt/memory 的页面来源、`finally` 里 `computerUse.endRun(threadId)`）
- Modify: `src/main/index.ts`（`computerUse.init()`）
- Create: `e2e/my-browser.mjs`；Modify: `package.json` 的 `test:e2e` 末尾追加 `&& node e2e/my-browser.mjs`
- Test: `tests/ext-driver.test.ts`（追加 targets 用例）、`e2e/my-browser.mjs`

**Interfaces:**
- Consumes: `builtinDriver`、`pageOf`、`ToolCtx`（Task 1）；`bridge`（Task 3）；`extTabs`、`ExternalPageDriver`（Task 4）。
- Produces（`src/shared/types.ts`）：
  ```ts
  export interface ComputerUseSettings { desktop: boolean; myBrowser: boolean; blockedApps: string[] }
  export interface DesktopStatus { supported: boolean; accessibility: boolean; screenRecording: boolean; helper: 'ok' | 'missing' | 'failed' }
  export interface ComputerUseStatus {
    browser: { connected: boolean; paired: boolean; browser: string | null; pairingCode: string | null; extensionDir: string }
    desktop: DesktopStatus | null   // Task 12 填充；之前恒为 null
  }
  ```
- Produces（`targets.ts`）：
  ```ts
  export type BrowserTarget = 'builtin' | 'mine'
  export const SANDBOX = '__sandbox__'
  export const targets: {
    get(threadId: string): BrowserTarget
    page(threadId: string): PageDriver          // builtin → builtinDriver(sessions.tabFor / browser.active)；mine → 该对话的外部标签页
    useMine(threadId: string): Promise<ExternalPageDriver>   // 选标签页并设为 mine；扩展未连接时抛 NeedExtension
    useTab(threadId: string, tabId: number): ExternalPageDriver
    useBuiltin(threadId: string): Promise<void>  // detach 外部标签页
    endRun(threadId: string): Promise<void>      // detach，但保留 'mine' 选择
  }
  export class NeedExtension extends Error {}
  ```
- Produces（`computer-use.ts`）：`export const computerUse: { init(): void; status(): ComputerUseStatus; endRun(threadId: string): Promise<void> }`（Task 12 扩展）。
- Produces（`tool-registry.ts`）：`systemPrompt(page: { title: string; url: string } | null, mem?: string | null): string`（第一个参数原来是 `WebContents`）。

- [ ] **Step 1: 写失败的测试**（追加到 `tests/ext-driver.test.ts`，用 `vi.mock` 替换 `../src/main/external-browser/bridge` 与 `../src/main/browser/agent-session`）

```ts
describe('targets', () => {
  it('defaults to the built-in browser', () => expect(targets.get('t1')).toBe('builtin'))
  it('uses the most recently handed tab, else opens a new one', async () => {
    // 有 handed [9, 8] → useMine('t1').tabId === 9；再对 't2' 调用 → 9 已被 t1 占用 → 8
    // 没有 handed → 调用 tabs.create
  })
  it('asks for the extension when it is not connected', async () => {
    // bridge.link() === null → rejects instanceof NeedExtension
  })
  it('endRun detaches but keeps the choice', async () => {
    // useMine('t1') 后 endRun('t1') → 该驱动的 detach 被调用；get('t1') 仍是 'mine'
  })
})
```

- [ ] **Step 2: 运行，确认失败**：`pnpm vitest run tests/ext-driver.test.ts` → targets 用例 FAIL

- [ ] **Step 3: 实现 `targets.ts`**。`SANDBOX` 用于开发者工具里的 `dev.invokeTool`（没有 threadId）：`activeTabCtx` 增加 `page: () => targets.page(SANDBOX)`，SANDBOX 的内置目标为 `builtinDriver(browser.active(), { agent: true })`。

- [ ] **Step 4: 设置与类型**：`DEFAULTS.computerUse = { desktop: false, myBrowser: false, blockedApps: ['com.apple.keychainaccess', 'com.apple.systempreferences', 'com.apple.Terminal', 'com.navo.app', ...(app.isPackaged ? [] : ['com.github.Electron'])] }`；`getSettings` 合并方式同 `voice`。

- [ ] **Step 5: 实现 `browser_switch`**（`external-browser/tools.ts`，`createSwitchTool(ctx: ToolCtx)`）：
  - schema `z.object({ target: z.enum(['builtin', 'mine']) })`，description：`切换本对话使用的浏览器：builtin 为 Navo 内置浏览器（默认）；mine 为用户自己的浏览器（Chrome / Edge 等，已登录的账号和插件都在）。切换后 browser_* 工具都作用在该浏览器上。`
  - `mine` 成功返回 `已切换到你的浏览器（<browser>）：\n<fullSnapshot>`；`NeedExtension` 时发事件 `computerUse.guide` 并返回 `用户还没有连接 Navo 浏览器扩展。界面上已弹出安装引导，请让用户按引导完成后告诉你，再调用 browser_switch('mine')。`
  - `builtin` 返回 `已切换回内置浏览器。`
- [ ] **Step 6: `browser_tabs` / `browser_downloads` 外部分支**：目标为 `mine` 时，`list` 返回 `extTabs.list()`（`current` 标记当前标签页），`new` 用 `extTabs.create(url)` 并 `targets.useTab`，`switch` 用 `targets.useTab`（不可用时返回错误文字），`close` 用 `extTabs.close`；`browser_downloads` 返回 `extTabs.downloads()` 并说明 `文件保存在你浏览器自己的下载目录`。

- [ ] **Step 7: tool-registry**：
  - `myBrowser` 开启时加入 `createSwitchTool(ctx)`（source `'browser'`）。
  - `plugins.tools(...)` 与 `recorder.tools(...)` 返回的每个工具包一层：`targets.get(ctx.threadId ?? SANDBOX) === 'mine'` 时直接返回 `这个工具只能在内置浏览器中使用，请先调用 browser_switch('builtin')。`，否则调用原工具。
  - `systemPrompt` 第一个参数改为 `{ title, url } | null`，`mine` 时那一行写 `本对话使用用户自己浏览器中的标签页: …`。`myBrowser` 或 `desktop` 开启时追加：
    ```
    ## 电脑操作准则
    - 网页任务默认用内置浏览器；需要用户已登录的账号，或用户说「用我的浏览器」时，调用 browser_switch('mine')。
    - 在用户的浏览器和 App 里，发送、付款、删除前先向用户确认。
    ```
    `desktop` 开启时再追加三行（Task 11 才会有这些工具，此处一并写好）：
    ```
    - Safari、Firefox 和其他 App 用 desktop_* 工具：先 desktop_activate，再 desktop_snapshot 读取元素树。
    - 优先按 [dN] 元素引用操作；元素树里找不到目标时，再用 desktop_screenshot + 坐标。
    - 用户按 Esc 或移动鼠标会立即停止你的操作，这不是错误，停下等用户说明即可。
    ```
- [ ] **Step 8: agent-service**：`ctx = { threadId, tab: () => sessions.tabFor(threadId), page: () => targets.page(threadId) }`；记忆和系统提示词用的页面信息：目标为 `mine` 时取外部驱动的 `url()/title()`，否则保持现状；`finally` 中 `await computerUse.endRun(threadId)`。

- [ ] **Step 9: `computer-use.ts` 与 IPC**：`init()` 按 `computerUse.myBrowser` 启停 `bridge`（设置变化时也处理），`bridge.onChange` → `emit('computerUse.changed', status())`；`computerUse.confirmPairing(approve: boolean)` → `bridge.confirmPairing`。`extensionDir` 在 Task 6 之前先返回 `join(paths.userData, 'browser-extension')`。

- [ ] **Step 10: 写 `e2e/my-browser.mjs`**：
  - 本地 `http.createServer` 提供 `e2e/tools.mjs` 里同样的 FORM 页面。
  - 启动 Navo（`AB_USER_DATA` 临时目录），`settings.set({ computerUse: { ...cur, myBrowser: true } })`。
  - `chromium.launchPersistentContext(tmp, { headless: true, args: ['--disable-extensions-except=dist/extension', '--load-extension=dist/extension'] })`（Playwright 自带的 Chromium）。
  - 轮询 `computerUse.status` 直到 `pairingCode` 出现 → `computerUse.confirmPairing(true)` → 轮询到 `paired: true`。
  - `dev.invokeTool('browser_switch', { target: 'mine' })` → `browser_navigate` 到测试页 → 断言 `[eN] textbox "Name"`；`browser_type` → `browser_click` → 断言 `Hello Ada`；`browser_extract` 含 `Hello Ada`；用 `context.newPage()` 打开一个「用户的」标签页后，`browser_tabs {action:'list'}` 的结果不含它。
  - 关闭 Chromium 后，`browser_snapshot` 在 15 秒内返回 `与浏览器扩展的连接已断开`。
  - 输出风格同其他 suite（`PASS`/`FAIL` 行，失败时 `process.exitCode = 1`）。

- [ ] **Step 11: 验证**

Run: `pnpm vitest run tests/ext-driver.test.ts && pnpm typecheck && pnpm build:extension && electron-vite build && node e2e/my-browser.mjs && node e2e/tools.mjs`
Expected: 单测 PASS；两个 E2E 只有 `PASS` 行

- [ ] **Step 12: Commit**

```bash
git add src e2e/my-browser.mjs tests/ext-driver.test.ts package.json
git commit -m "feat(my-browser): browser_switch — browser tools work in the user's own browser"
```

---
### Task 6: 扩展安装、导入引导、配对确认与设置页（浏览器部分）

**Files:**
- Create: `src/main/external-browser/install.ts`
- Create: `src/renderer/src/components/browser/extension-guide.tsx`、`src/renderer/src/components/settings/computer-use-section.tsx`
- Modify: `src/main/computer-use.ts`（`extensionDir` 改用 `install.ts`；新增 IPC 处理）、`src/shared/ipc-contract.ts`、`src/main/handlers.ts`
- Modify: `src/renderer/src/pages/settings.tsx:394`（`VoiceSection` 之后插入 `<ComputerUseSection …/>`）、`src/renderer/src/App.tsx`（主窗口挂载 `<ExtensionGuideHost />`）
- Modify: `src/shared/locales/en.json`
- Test: `tests/ext-install.test.ts`

**Interfaces:**
- Consumes: `ComputerUseStatus`（Task 5）；`bridge`（Task 3）。
- Produces（`install.ts`）：
  ```ts
  export interface InstallResult { dir: string; updated: boolean }
  export function installExtension(src: string, dest: string): InstallResult   // 纯文件操作，可单测
  export function ensureExtension(): InstallResult  // src = app.isPackaged ? join(process.resourcesPath, 'extension') : appFile('dist/extension'); dest = join(paths.userData, 'browser-extension')
  ```
- Produces（IPC）：`'computerUse.installExtension': () => { dir: string }`、`'computerUse.openExtensionsPage': (browser: 'chrome' | 'edge' | 'other') => { opened: boolean; url: string }`；事件 `'computerUse.guide': void` 已在 Task 5 定义。
- Produces（renderer）：`export function ExtensionGuide({ status, onClose }: { status: ComputerUseStatus; onClose: () => void })`、`export function ExtensionGuideHost()`、`export function ComputerUseSection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<void> })`。

- [ ] **Step 1: 写失败的测试** `tests/ext-install.test.ts`（临时目录里造 `src/manifest.json`）

```ts
it('copies the extension the first time', () => {
  // dest 不存在 → { updated: true }，dest/manifest.json 存在
})
it('leaves the same version alone', () => {
  // 第二次调用 → { updated: false }；dest 里用户无关的文件 mtime 不变
})
it('replaces files when the version changes, keeping the folder', () => {
  // src manifest version 改为 0.2.0、删掉 src/old.js → { updated: true }；dest/manifest.json 版本 0.2.0；dest/old.js 不存在；dest 目录 inode 不变（Chrome 记住的是这个路径）
})
```

- [ ] **Step 2: 运行，确认失败**：`pnpm vitest run tests/ext-install.test.ts` → FAIL

- [ ] **Step 3: 实现 `installExtension`**：比较两边 `manifest.json` 的 `version`；不同则清空 dest 里的内容（不删 dest 目录本身）再 `cpSync(src, dest, { recursive: true })`。`ensureExtension` 在 `updated` 且 `bridge.link()` 存在时发 `ext.reload` 请求（忽略错误）。`computerUse.init()` 在 `myBrowser` 开启时调用一次 `ensureExtension()`。`electron-builder.yml` 已在 Task 2 加了 `extraResources`。

- [ ] **Step 4: 运行测试**：`pnpm vitest run tests/ext-install.test.ts` → PASS

- [ ] **Step 5: `openExtensionsPage`**：`chrome` → `open -a "Google Chrome" chrome://extensions`，`edge` → `open -a "Microsoft Edge" edge://extensions`（用 `execFile('open', ['-a', name, url])`，不经 shell）；失败或 `other` 返回 `{ opened: false, url: 'chrome://extensions' }`，界面提示用户复制地址。

- [ ] **Step 6: `ExtensionGuide` 组件**（`Dialog`）。三步文案：
  1. `在浏览器里打开扩展程序页面` + 按钮「在 Chrome 中打开」「在 Edge 中打开」，未能打开时显示地址 `chrome://extensions` 与「复制」按钮
  2. `打开右上角的「开发者模式」`
  3. `点「加载已解压的扩展程序」，选择这个文件夹` + 路径 + 按钮「在访达中显示」（`app.showItemInFolder`）
  
  底部说明：`如果浏览器启动时提示停用开发者模式扩展，点关闭即可，扩展会继续可用。需要上传文件时，请在扩展详情里打开「允许访问文件网址」。`

  `status.browser.pairingCode` 出现后切换为配对确认：`浏览器扩展请求连接 Navo。请确认扩展弹出页里显示的配对码与下面一致：` + 大号配对码 + 「确认连接」「拒绝」（`computerUse.confirmPairing`）。`paired` 后显示 `已连接 <browser>` 并在 1.5 秒后关闭。`ExtensionGuideHost` 监听 `computerUse.guide` 与 `computerUse.changed`：收到 guide 或出现 `pairingCode` 时打开对话框（打开前调用 `computerUse.installExtension`）。

- [ ] **Step 7: `ComputerUseSection`（浏览器部分）**：标题 `电脑操作`；Row `使用我的浏览器`，描述 `让 Agent 在你自己的 Chrome / Edge 里操作，用上已登录的账号和插件。需要先导入 Navo 浏览器扩展`，Switch 写 `computerUse.myBrowser`；开启后下面一行显示连接状态（`已连接 <browser>` / `未连接`）与按钮「导入扩展」（打开 `ExtensionGuide`）。`data-testid="computer-use-settings"`。桌面部分留给 Task 12。

- [ ] **Step 8: i18n 与验证**：新文案全部包 `t()`，补 `en.json`。

Run: `pnpm i18n:check && pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过

手动：`pnpm dev` → 设置 → 电脑操作 → 开启「使用我的浏览器」→「导入扩展」→ 在本机 Chrome 按引导加载 `~/Library/Application Support/Navo/browser-extension` → Navo 弹出配对码，与扩展弹出页一致 → 确认后显示「已连接 Chrome」。

- [ ] **Step 9: Commit**

```bash
git add src tests/ext-install.test.ts
git commit -m "feat(my-browser): import guide, pairing and settings for the browser extension"
```

---
<!-- TASKS -->
