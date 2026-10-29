import { chooserNotice, dialogNotice, DIALOG_SHIM } from '../browser/dialogs'
import type { DialogPolicy, PageDriver } from '../browser/page-driver'
import { normalizeUrl, RUNTIME_SRC } from '../browser/page-source'
import type { Link } from './bridge'
import type { ExtTab } from './protocol'

/** The current link to the extension, waiting up to `waitMs` for it to (re)connect; null if it doesn't. */
export type GetLink = (waitMs: number) => Promise<Link | null>

export interface ExtTabInfo {
  tabId: number
  url: string
  title: string
  /** opened by the agent (otherwise handed over by the user) */
  owned: boolean
}

/** how long a call waits for the extension to come back after it disconnected */
const RECONNECT_MS = 15_000
const WORLD = 'navo-agent'
const OFFLINE = '与浏览器扩展的连接已断开，请确认浏览器已打开、Navo 扩展已启用'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Evaluated<T> = { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }

/** The message of an exception thrown in the page, without its stack. */
function pageError(d: NonNullable<Evaluated<unknown>['exceptionDetails']>): Error {
  const text = d.exception?.description ?? d.text ?? '页面脚本出错'
  return new Error(text.split('\n')[0].replace(/^[A-Za-z]*Error: /, ''))
}

/** A tab in the user's own browser, driven over the extension's chrome.debugger relay. */
export class ExternalPageDriver implements PageDriver {
  readonly id: string
  readonly kind = 'external' as const
  private info: { url: string; title: string }
  /** the link the debugger is attached over; another link means attach again */
  private attachedOn: Link | null = null
  private preparedOn: Link | null = null
  private contextId: number | null = null
  private closedTab = false
  private cancelled = false
  private notices: string[] = []
  private pendingChooser: { backendNodeId: number } | null = null
  private policy: DialogPolicy = { confirm: false, prompt: null }

  constructor(
    private tabs: ExtTabs,
    readonly tabId: number,
    info: { url: string; title: string },
  ) {
    this.id = `ext:${tabId}`
    this.info = { ...info }
  }

  /** the tab was closed, or the user took it back by cancelling the debugging session */
  get gone(): boolean {
    return this.closedTab || this.cancelled
  }

  url(): string {
    return this.info.url
  }

  title(): string {
    return this.info.title
  }

  private async ensure(): Promise<Link> {
    if (this.closedTab) throw new Error('标签页已被关闭，请用 browser_tabs 新建一个')
    if (this.cancelled) throw new Error('用户在浏览器里取消了调试，这个标签页已收回')
    const link = await this.tabs.connect(RECONNECT_MS)
    if (this.attachedOn !== link) {
      this.contextId = null
      this.preparedOn = null
      await link.request('debugger.attach', { tabId: this.tabId })
      this.attachedOn = link
    }
    return link
  }

  cdp = async <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const link = await this.ensure()
    return link.request<T>('cdp.send', { tabId: this.tabId, method, params })
  }

  private async world(): Promise<number> {
    // a new link (the extension reconnected) drops the old world: attach first
    await this.ensure()
    if (this.contextId != null) return this.contextId
    const tree = await this.cdp<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    const { executionContextId } = await this.cdp<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: WORLD,
    })
    this.contextId = executionContextId
    return executionContextId
  }

  private async evaluate<T>(expression: string, contextId?: number): Promise<T> {
    const res = await this.cdp<Evaluated<T>>('Runtime.evaluate', {
      expression,
      ...(contextId != null ? { contextId } : {}),
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) throw pageError(res.exceptionDetails)
    return res.result?.value as T
  }

  async evalIn<T = unknown>(code: string): Promise<T> {
    const expression = `(async () => { ${RUNTIME_SRC} return (${code}); })()`
    try {
      return await this.evaluate<T>(expression, await this.world())
    } catch (err) {
      // the document changed between creating the world and using it
      if (!/Cannot find context/i.test((err as Error).message)) throw err
      this.contextId = null
      return this.evaluate<T>(expression, await this.world())
    }
  }

  evalMain<T = unknown>(script: string): Promise<T> {
    return this.evaluate<T>(`(async () => { ${script} })()`)
  }

  async navigate(url: string): Promise<void> {
    const target = normalizeUrl(url)
    const res = await this.cdp<{ errorText?: string }>('Page.navigate', { url: target })
    if (res?.errorText && !/ERR_ABORTED/.test(res.errorText)) throw new Error(`打开网页失败：${res.errorText}`)
    this.info.url = target
    this.contextId = null
  }

  async history(action: 'back' | 'forward'): Promise<boolean> {
    const h = await this.cdp<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory')
    const entry = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)]
    if (!entry) return false
    await this.cdp('Page.navigateToHistoryEntry', { entryId: entry.id })
    return true
  }

  async waitForLoad(timeout = 15000): Promise<void> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>('document.readyState').catch(() => null)
      if (state === 'complete') return
      await sleep(200)
    }
  }

  async prepare(): Promise<void> {
    const link = await this.ensure()
    if (this.preparedOn === link) return
    await this.cdp('Page.enable')
    await this.cdp('Runtime.enable')
    await this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM })
    await this.cdp('Runtime.evaluate', { expression: DIALOG_SHIM })
    await this.applyPolicy()
    await this.cdp('Page.setInterceptFileChooserDialog', { enabled: true })
    this.preparedOn = link
  }

  private applyPolicy(): Promise<unknown> {
    return this.cdp('Runtime.evaluate', { expression: `window.__navoDialogPolicy = ${JSON.stringify(this.policy)}` }).catch(() => undefined)
  }

  async bringToFront(): Promise<void> {
    const link = await this.ensure()
    await link.request('tabs.activate', { tabId: this.tabId })
    await this.cdp('Page.bringToFront')
  }

  takeNotices(): string[] {
    const out = this.notices
    this.notices = []
    return out
  }

  chooser(): { backendNodeId: number } | null {
    return this.pendingChooser
  }

  clearChooser(): void {
    this.pendingChooser = null
  }

  async setDialogPolicy(p: DialogPolicy): Promise<void> {
    this.policy = { ...p }
    if (this.preparedOn) await this.applyPolicy()
  }

  /** Lets the user's browser have the tab back (the agent can attach again later). */
  async detach(): Promise<void> {
    const link = this.attachedOn
    this.attachedOn = null
    this.preparedOn = null
    this.contextId = null
    if (link && !link.closed && !this.closedTab) await link.request('debugger.detach', { tabId: this.tabId }).catch(() => undefined)
  }

  // ---------- events from the extension (routed by ExtTabs) ----------

  onCdp(method: string, raw: Record<string, unknown>): void {
    const params = raw as {
      frame?: { id?: string; parentId?: string; url?: string }
      args?: { value?: unknown }[]
      backendNodeId?: number
      mode?: string
      suggestedFilename?: string
      url?: string
      type?: string
      message?: string
    }
    switch (method) {
      case 'Page.frameNavigated':
        if (params.frame?.parentId) return
        this.contextId = null
        if (params.frame?.url) this.info.url = params.frame.url
        if (this.preparedOn) void this.applyPolicy()
        return
      case 'Runtime.executionContextsCleared':
        this.contextId = null
        return
      case 'Runtime.consoleAPICalled': {
        const notice = dialogNotice(String(params.args?.[0]?.value ?? ''))
        if (notice) this.notices.push(notice)
        return
      }
      case 'Page.fileChooserOpened':
        if (!params.backendNodeId) return
        this.pendingChooser = { backendNodeId: params.backendNodeId }
        this.notices.push(chooserNotice(params.mode ?? 'selectSingle'))
        return
      case 'Page.downloadWillBegin': {
        const filename = String(params.suggestedFilename ?? params.url ?? '')
        this.tabs.addDownload({ filename, url: String(params.url ?? '') })
        this.notices.push(`开始下载：${filename}（保存在你浏览器自己的下载目录）`)
        return
      }
      case 'Page.javascriptDialogOpening':
        void this.answerDialog(String(params.type), String(params.message ?? ''))
        return
    }
  }

  /** Dialogs the shim didn't catch (opened before it was in place, beforeunload) follow the same policy. */
  private async answerDialog(type: string, message: string): Promise<void> {
    if (type === 'beforeunload') {
      await this.cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined)
      return
    }
    const answer = type === 'alert' ? null : type === 'confirm' ? this.policy.confirm : this.policy.prompt
    const accept = type === 'alert' || (type === 'confirm' ? !!answer : answer != null)
    await this.cdp('Page.handleJavaScriptDialog', type === 'prompt' && answer != null ? { accept, promptText: answer } : { accept }).catch(() => undefined)
    const notice = dialogNotice('__navo_dialog__' + JSON.stringify({ type, message, answer }))
    if (notice) this.notices.push(notice)
  }

  onUpdated(info: { url?: string; title?: string }): void {
    if (info.url) this.info.url = info.url
    if (info.title != null) this.info.title = info.title
  }

  onRemoved(): void {
    this.closedTab = true
    this.attachedOn = null
  }

  onDetached(reason: string): void {
    this.attachedOn = null
    this.preparedOn = null
    this.contextId = null
    if (reason === 'canceled_by_user') this.cancelled = true
    if (reason === 'target_closed') this.closedTab = true
  }
}

/**
 * The tabs of the user's browser Navo may use: the ones the agent opened, and the ones the user
 * handed over from the extension's popup. Everything else in the browser stays out of reach.
 */
export class ExtTabs {
  private link: Link | null = null
  private unwatch: (() => void)[] = []
  private owned = new Set<number>()
  private handedTabs = new Map<number, ExtTab & { at: number }>()
  private drivers = new Map<number, ExternalPageDriver>()
  private recent: { filename: string; url: string }[] = []

  constructor(private getLink: GetLink) {}

  /** The link to the extension, waiting for it to reconnect if it dropped. */
  async connect(waitMs: number): Promise<Link> {
    if (this.link && !this.link.closed) return this.link
    const link = await this.getLink(waitMs)
    if (!link || link.closed) throw new Error(OFFLINE)
    if (link !== this.link) this.watch(link)
    return link
  }

  /** Follows a (new) link's events: handovers, closed tabs, CDP events of the tabs in use. */
  watch(link: Link): void {
    for (const off of this.unwatch) off()
    this.link = link
    this.unwatch = [
      link.on<ExtTab>('handover', (t) => this.handedTabs.set(t.tabId, { ...t, at: Date.now() })),
      link.on<{ tabId: number }>('revoke', ({ tabId }) => this.forget(tabId, false)),
      link.on<{ tabId: number }>('tabRemoved', ({ tabId }) => {
        this.drivers.get(tabId)?.onRemoved()
        this.forget(tabId, true)
      }),
      link.on<ExtTab>('tabUpdated', (t) => {
        this.drivers.get(t.tabId)?.onUpdated(t)
        const h = this.handedTabs.get(t.tabId)
        if (h) Object.assign(h, { url: t.url, title: t.title })
      }),
      link.on<{ tabId: number; reason: string }>('detached', ({ tabId, reason }) => this.drivers.get(tabId)?.onDetached(reason)),
      link.on<{ tabId: number; method: string; params: Record<string, unknown> }>('cdp', ({ tabId, method, params }) =>
        this.drivers.get(tabId)?.onCdp(method, params ?? {}),
      ),
    ]
  }

  private forget(tabId: number, closed: boolean): void {
    this.handedTabs.delete(tabId)
    if (closed) this.owned.delete(tabId)
    if (closed || !this.owned.has(tabId)) this.drivers.delete(tabId)
  }

  async create(url?: string): Promise<ExternalPageDriver> {
    const link = await this.connect(RECONNECT_MS)
    const tab = await link.request<ExtTab>('tabs.create', { url: url ? normalizeUrl(url) : 'about:blank' })
    this.owned.add(tab.tabId)
    const driver = new ExternalPageDriver(this, tab.tabId, tab)
    this.drivers.set(tab.tabId, driver)
    return driver
  }

  async list(): Promise<ExtTabInfo[]> {
    const link = await this.connect(RECONNECT_MS)
    const all = await link.request<(ExtTab & { handed?: boolean })[]>('tabs.list')
    const present = new Set(all.map((t) => t.tabId))
    for (const id of [...this.owned]) if (!present.has(id)) this.forget(id, true)
    for (const t of all) {
      // the extension remembers handovers made while Navo wasn't listening
      if (t.handed === true && !this.handedTabs.has(t.tabId)) this.handedTabs.set(t.tabId, { ...t, at: Date.now() })
      if (t.handed === false && this.handedTabs.has(t.tabId)) this.forget(t.tabId, false)
    }
    return all
      .filter((t) => this.owned.has(t.tabId) || this.handedTabs.has(t.tabId))
      .map((t) => ({ tabId: t.tabId, url: t.url, title: t.title, owned: this.owned.has(t.tabId) }))
  }

  /** Tabs the user handed over, most recent first. */
  handed(): ExtTabInfo[] {
    return [...this.handedTabs.values()].sort((a, b) => b.at - a.at).map((t) => ({ tabId: t.tabId, url: t.url, title: t.title, owned: false }))
  }

  driver(tabId: number): ExternalPageDriver {
    if (!this.owned.has(tabId) && !this.handedTabs.has(tabId)) throw new Error(`这个标签页（${tabId}）没有交给 Navo`)
    let d = this.drivers.get(tabId)
    if (!d) {
      const h = this.handedTabs.get(tabId)
      d = new ExternalPageDriver(this, tabId, { url: h?.url ?? '', title: h?.title ?? '' })
      this.drivers.set(tabId, d)
    }
    return d
  }

  async close(tabId: number): Promise<void> {
    if (!this.owned.has(tabId) && !this.handedTabs.has(tabId)) throw new Error(`这个标签页（${tabId}）没有交给 Navo`)
    const link = await this.connect(RECONNECT_MS)
    await link.request('tabs.close', { tabId })
    this.drivers.get(tabId)?.onRemoved()
    this.forget(tabId, true)
  }

  addDownload(d: { filename: string; url: string }): void {
    this.recent.unshift(d)
    this.recent.length = Math.min(this.recent.length, 10)
  }

  downloads(): { filename: string; url: string }[] {
    return [...this.recent]
  }
}
