import type { WebContents } from 'electron'
import { log } from '../core/logger'
import { browser } from './browser-service'

/**
 * Replaces alert/confirm/prompt in the page's main world while an agent drives the tab.
 * Native dialogs would block the page (and the agent) until a human clicks them.
 * alert is acknowledged, confirm/prompt follow `window.__navoDialogPolicy` (dismiss by default),
 * and every dialog is reported to the agent through a console marker.
 */
const DIALOG_SHIM = `(() => {
  if (window.__navoShim) return; window.__navoShim = true;
  const o = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }; window.__navoOrig = o;
  const rep = (type, message, answer) => { try { console.debug('__navo_dialog__' + JSON.stringify({ type, message: String(message ?? '').slice(0, 500), answer })) } catch (e) {} };
  window.alert = function (m) { rep('alert', m, null) };
  window.confirm = function (m) { const a = !!(window.__navoDialogPolicy && window.__navoDialogPolicy.confirm); rep('confirm', m, a); return a };
  window.prompt = function (m, d) { const p = window.__navoDialogPolicy; const a = p && typeof p.prompt === 'string' ? p.prompt : null; rep('prompt', m, a); return a };
})()`
const RESTORE = `(() => { if (window.__navoOrig) { Object.assign(window, window.__navoOrig); delete window.__navoShim } })()`

interface Policy {
  confirm: boolean
  prompt: string | null
}

interface TabAgentState {
  scriptId?: string
  policy: Policy
  chooser?: { backendNodeId: number; mode: string }
  notices: string[]
  listeners?: () => void
}

/** Per-conversation tab ownership + page-event plumbing for agent runs. */
class AgentSessions {
  private tabOf = new Map<string, number>()
  private running = new Map<string, string>() // threadId -> title
  private tabs = new Map<number, TabAgentState>()

  init(): void {
    browser.onDomReady(async (wc) => {
      const st = this.tabs.get(wc.id)
      if (st?.scriptId) await this.applyPolicy(wc, st.policy)
    })
    browser.onDownload((d) => {
      if (d.tabId == null) return
      const msg =
        d.state === 'completed'
          ? `文件已下载：${d.filename} → ${d.path}`
          : d.state === 'progressing'
            ? `开始下载：${d.filename}（保存到 ${d.path}）`
            : `下载${d.state === 'cancelled' ? '已取消' : '中断'}：${d.filename}`
      this.notice(d.tabId, msg)
    })
    browser.onPopup((opener, popup) => {
      this.notice(
        opener.id,
        `页面打开了一个弹出窗口「${popup.getTitle() || popup.webContents.getURL()}」（通常是登录/授权）。请让用户在弹窗中完成操作，完成后弹窗会自动关闭，再继续任务。`,
      )
      popup.show()
    })
  }

  begin(threadId: string, title: string): void {
    this.running.set(threadId, title)
    const tabId = this.tabOf.get(threadId)
    if (tabId != null && browser.tab(tabId)) browser.setOwner(tabId, { threadId, title, running: true })
  }

  /**
   * The tab this conversation drives. Reuses its previous tab, otherwise takes the active tab unless
   * another running conversation owns it, in which case a fresh tab is opened.
   */
  tabFor(threadId: string): WebContents {
    const title = this.running.get(threadId) ?? '对话'
    const existing = this.tabOf.get(threadId)
    if (existing != null) {
      const wc = browser.tab(existing)
      if (wc && !wc.isDestroyed()) return wc
    }
    const activeId = browser.activeId_()
    const activeOwner = activeId != null ? browser.owner(activeId) : undefined
    const useActive = activeId != null && (!activeOwner || activeOwner.threadId === threadId || !activeOwner.running)
    const id = useActive ? activeId! : browser.newTab(undefined, { activate: this.running.size <= 1 })
    this.tabOf.set(threadId, id)
    browser.setOwner(id, { threadId, title, running: this.running.has(threadId) })
    return browser.tab(id)!
  }

  /** The conversation's tab if it has one, otherwise the active tab. Never claims. */
  peek(threadId: string): WebContents | null {
    const id = this.tabOf.get(threadId)
    const wc = id != null ? browser.tab(id) : null
    return wc && !wc.isDestroyed() ? wc : browser.tab(browser.activeId_() ?? -1)
  }

  /** Switches which tab a conversation drives (browser_tabs switch/new). */
  assign(threadId: string, tabId: number): void {
    const prev = this.tabOf.get(threadId)
    if (prev != null && prev !== tabId) browser.setOwner(prev, null)
    this.tabOf.set(threadId, tabId)
    browser.setOwner(tabId, { threadId, title: this.running.get(threadId) ?? '对话', running: this.running.has(threadId) })
  }

  async end(threadId: string): Promise<void> {
    this.running.delete(threadId)
    const tabId = this.tabOf.get(threadId)
    const wc = tabId != null ? browser.tab(tabId) : null
    if (tabId != null) {
      const owner = browser.owner(tabId)
      if (owner) browser.setOwner(tabId, { ...owner, running: false })
    }
    if (wc && !wc.isDestroyed()) {
      await this.release(wc)
      await browser.setControlled(wc, false)
    }
  }

  forget(threadId: string): void {
    const tabId = this.tabOf.get(threadId)
    if (tabId != null) browser.setOwner(tabId, null)
    this.tabOf.delete(threadId)
  }

  private state(tabId: number): TabAgentState {
    let st = this.tabs.get(tabId)
    if (!st) {
      st = { policy: { confirm: false, prompt: null }, notices: [] }
      this.tabs.set(tabId, st)
    }
    return st
  }

  notice(tabId: number, text: string): void {
    this.state(tabId).notices.push(text)
  }

  takeNotices(wc: WebContents): string[] {
    const st = this.tabs.get(wc.id)
    if (!st) return []
    const out = st.notices
    st.notices = []
    return out
  }

  chooser(wc: WebContents): TabAgentState['chooser'] {
    return this.tabs.get(wc.id)?.chooser
  }

  clearChooser(wc: WebContents): void {
    const st = this.tabs.get(wc.id)
    if (st) st.chooser = undefined
  }

  /** Installs dialog shim + file chooser interception on a tab the agent is about to drive. */
  async prepare(wc: WebContents): Promise<void> {
    const st = this.state(wc.id)
    if (st.scriptId) return
    try {
      const { identifier } = await browser.cdp<{ identifier: string }>(wc, 'Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM })
      st.scriptId = identifier
      await browser.cdp(wc, 'Page.enable')
      await browser.cdp(wc, 'Runtime.evaluate', { expression: DIALOG_SHIM })
      await this.applyPolicy(wc, st.policy)
      await browser.cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: true })
    } catch (err) {
      log.warn(`[agent-session] prepare failed: ${(err as Error).message}`)
    }
    if (st.listeners) return
    const onCdp = (_e: unknown, method: string, params: { backendNodeId?: number; mode?: string }) => {
      if (method === 'Page.fileChooserOpened' && params.backendNodeId) {
        st.chooser = { backendNodeId: params.backendNodeId, mode: params.mode ?? 'selectSingle' }
        this.notice(
          wc.id,
          `页面打开了文件选择框（${params.mode === 'selectMultiple' ? '可多选' : '单选'}）。请调用 browser_upload_file 并提供文件的绝对路径（无需 ref）。`,
        )
      }
    }
    const onConsole = (...args: unknown[]) => {
      // Electron >= 35 passes a details object; older versions pass (event, level, message)
      const first = args[0] as { message?: string }
      const message = typeof first?.message === 'string' ? first.message : (args[2] as string)
      if (typeof message !== 'string' || !message.startsWith('__navo_dialog__')) return
      try {
        const d = JSON.parse(message.slice('__navo_dialog__'.length)) as { type: string; message: string; answer: unknown }
        const kind = d.type === 'alert' ? '提示框' : d.type === 'confirm' ? '确认框' : '输入框'
        const outcome =
          d.type === 'alert'
            ? '已关闭'
            : d.type === 'confirm'
              ? `已自动选择「${d.answer ? '确定' : '取消'}」`
              : d.answer == null
                ? '已取消'
                : `已填写「${String(d.answer)}」`
        const hint = d.type === 'alert' ? '' : '。如需不同的选择，请调用 browser_set_dialog_policy 设置后重试该操作'
        this.notice(wc.id, `页面弹出${kind}：「${d.message}」，${outcome}${hint}`)
      } catch {
        /* malformed marker */
      }
    }
    wc.debugger.on('message', onCdp as never)
    wc.on('console-message', onConsole as never)
    st.listeners = () => {
      wc.debugger.removeListener('message', onCdp as never)
      wc.removeListener('console-message', onConsole as never)
    }
  }

  /** Removes the shim so the user gets normal dialogs / file pickers again. */
  async release(wc: WebContents): Promise<void> {
    const st = this.tabs.get(wc.id)
    if (!st?.scriptId) return
    try {
      await browser.cdp(wc, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: st.scriptId })
      await browser.cdp(wc, 'Runtime.evaluate', { expression: RESTORE })
      await browser.cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: false })
    } catch {
      /* tab navigating or closed */
    }
    st.listeners?.()
    this.tabs.set(wc.id, { policy: { confirm: false, prompt: null }, notices: [] })
  }

  async setPolicy(wc: WebContents, policy: Policy): Promise<void> {
    this.state(wc.id).policy = policy
    await this.applyPolicy(wc, policy)
  }

  private async applyPolicy(wc: WebContents, policy: Policy): Promise<void> {
    await browser.cdp(wc, 'Runtime.evaluate', { expression: `window.__navoDialogPolicy = ${JSON.stringify(policy)}` }).catch(() => undefined)
  }
}

export const sessions = new AgentSessions()
