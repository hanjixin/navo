import { app, type BrowserWindow, dialog, WebContentsView, session, type WebContents } from 'electron'
import { appFile } from '../core/app-dir'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { extname, basename as pathBasename } from 'node:path'
import { join } from 'node:path'
import type { Bounds, BrowserState, BrowserTab, DownloadInfo } from '@shared/types'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { pageRuntime } from './page-runtime'

/** Isolated world shared by the tab preload, agent runtime, plugins and recorder. */
export const AGENT_WORLD = 999
const PARTITION = 'persist:agent'
const HOME = 'https://www.bing.com'
const RUNTIME_SRC = `(${pageRuntime.toString()})();`

type DomReadyHook = (wc: WebContents) => void | Promise<void>

interface Tab {
  view: WebContentsView
  favicon?: string
  /** URL requested but not yet committed, so the address bar isn't blank while the first load starts */
  pendingUrl?: string
  /** Conversation that uses this tab (set while / after an agent run claimed it) */
  owner?: { threadId: string; title: string; running: boolean }
}

export type { DownloadInfo }

function uniquePath(dir: string, name: string): string {
  const ext = extname(name)
  const base = pathBasename(name, ext) || 'download'
  let p = join(dir, `${base}${ext}`)
  for (let i = 1; existsSync(p); i++) p = join(dir, `${base} (${i})${ext}`)
  return p
}

class BrowserService {
  private win: BrowserWindow | null = null
  private tabs = new Map<number, Tab>()
  private order: number[] = []
  private activeId: number | null = null
  private bounds: Bounds | null = null
  private attached = false
  /** mini preview while the panel is collapsed: the page stays attached just outside the window */
  private previewTimer: NodeJS.Timeout | null = null
  private previewLast = ''
  private pageSize = { width: 1280, height: 800 }
  /** Tabs currently driven by an agent run */
  private controlled = new Set<number>()
  /** tab an agent most recently started driving (what the mini window follows) */
  private lastControlled: number | null = null
  recording = false
  downloads: DownloadInfo[] = []
  private downloadHooks: ((d: DownloadInfo) => void)[] = []
  private domReadyHooks: DomReadyHook[] = []
  private emitTimer: NodeJS.Timeout | null = null

  init(win: BrowserWindow): void {
    this.win = win
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['clipboard-sanitized-write', 'fullscreen'].includes(permission)))
    // downloads never open a save dialog: they land in ~/Downloads and are reported to the UI / agent
    ses.on('will-download', (_e, item, wc) => {
      const d: DownloadInfo = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tabId: wc && this.tabs.has(wc.id) ? wc.id : null,
        filename: item.getFilename(),
        path: uniquePath(app.getPath('downloads'), item.getFilename()),
        state: 'progressing',
        received: 0,
        total: item.getTotalBytes(),
      }
      item.setSavePath(d.path)
      this.downloads = [d, ...this.downloads].slice(0, 50)
      const notify = () => this.downloadHooks.forEach((h) => h({ ...d }))
      item.on('updated', (_ev, state) => {
        d.received = item.getReceivedBytes()
        d.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      })
      item.once('done', (_ev, state) => {
        d.received = item.getReceivedBytes()
        d.state = state
        notify()
      })
      notify()
    })
    this.newTab(HOME)
  }

  onDownload(hook: (d: DownloadInfo) => void): void {
    this.downloadHooks.push(hook)
  }

  onDomReady(hook: DomReadyHook): void {
    this.domReadyHooks.push(hook)
  }

  state(): BrowserState {
    const tabs: BrowserTab[] = this.order.map((id) => {
      const t = this.tabs.get(id)!
      const wc = t.view.webContents
      return {
        id,
        url: wc.getURL() || t.pendingUrl || '',
        title: wc.getTitle() || '新标签页',
        favicon: t.favicon,
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        active: id === this.activeId,
        agent: t.owner ? { threadId: t.owner.threadId, title: t.owner.title, running: t.owner.running } : undefined,
      }
    })
    return { tabs, agentControlled: this.controlled.size > 0, recording: this.recording }
  }

  /** Debounced state push to the renderer. */
  changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      emit('browser.state', this.state())
    }, 30)
  }

  newTab(url = HOME, opts: { activate?: boolean } = {}): number {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: appFile('out/preload/tab.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    const id = wc.id
    this.tabs.set(id, { view, pendingUrl: normalizeUrl(url) })
    this.order.push(id)

    const update = () => this.changed()
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', update)
    wc.on('page-title-updated', update)
    wc.on('did-navigate', update)
    wc.on('did-navigate-in-page', update)
    wc.on('page-favicon-updated', (_e, favicons) => {
      const t = this.tabs.get(id)
      if (t) t.favicon = favicons[0]
      update()
    })
    wc.on('dom-ready', () => void this.handleDomReady(wc))
    wc.setWindowOpenHandler(({ url: target, features, disposition }) => {
      // Sized popups (window.open with width/height) are usually sign-in flows that talk back to the
      // opener via window.opener / postMessage; they must stay real windows sharing this session.
      if (disposition === 'new-window' || /(^|,)\s*(width|height|popup)\s*=/.test(features)) {
        const size = (k: string, d: number) => Number(new RegExp(`${k}\\s*=\\s*(\\d+)`).exec(features)?.[1]) || d
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: Math.min(size('width', 520), 1000),
            height: Math.min(size('height', 680), 900),
            parent: this.win ?? undefined,
            autoHideMenuBar: true,
            title: '登录',
            backgroundColor: '#ffffff',
          },
        }
      }
      this.activate(this.newTab(target))
      this.reveal()
      return { action: 'deny' }
    })
    wc.on('did-create-window', (popup) => {
      this.popupHooks.forEach((h) => h(wc, popup))
      // popups die with their opener tab
      wc.once('destroyed', () => !popup.isDestroyed() && popup.close())
    })
    // A beforeunload handler asks to stay on the page. Agents always leave; users get asked.
    wc.on('will-prevent-unload', (e) => {
      if (this.controlled.has(id)) return e.preventDefault()
      const choice = dialog.showMessageBoxSync(this.win!, {
        type: 'question',
        buttons: ['离开', '留下'],
        defaultId: 0,
        cancelId: 1,
        message: '此页面询问你是否要离开',
        detail: '你所做的更改可能不会保存。',
      })
      if (choice === 0) e.preventDefault()
    })
    wc.on('render-process-gone', (_e, d) => log.warn(`[browser] tab ${id} crashed: ${d.reason}`))

    void wc.loadURL(normalizeUrl(url)).catch((err) => log.warn(`[browser] load failed: ${err.message}`))
    if (opts.activate !== false) this.activate(id)
    else this.changed()
    return id
  }

  private popupHooks: ((opener: WebContents, popup: BrowserWindow) => void)[] = []
  onPopup(hook: (opener: WebContents, popup: BrowserWindow) => void): void {
    this.popupHooks.push(hook)
  }

  setOwner(tabId: number, owner: Tab['owner'] | null): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.owner = owner ?? undefined
    this.changed()
  }

  owner(tabId: number): Tab['owner'] | undefined {
    return this.tabs.get(tabId)?.owner
  }

  activeId_(): number | null {
    return this.activeId
  }

  private async handleDomReady(wc: WebContents): Promise<void> {
    try {
      await this.ensureRuntime(wc)
      if (this.controlled.has(wc.id)) await this.evalIn(wc, '__agent.setControlled(true)')
      for (const hook of this.domReadyHooks) await hook(wc)
    } catch (err) {
      log.warn(`[browser] dom-ready hooks failed: ${(err as Error).message}`)
    }
  }

  async ensureRuntime(wc: WebContents): Promise<void> {
    await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: RUNTIME_SRC }])
  }

  closeTab(id: number): void {
    const t = this.tabs.get(id)
    if (!t) return
    this.controlled.delete(id)
    if (this.attached && id === this.activeId) this.win?.contentView.removeChildView(t.view)
    t.view.webContents.close()
    this.tabs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    if (this.activeId === id) {
      this.activeId = null
      this.attached = false
      const next = this.order.at(-1)
      if (next != null) this.activate(next)
    }
    this.changed()
  }

  activate(id: number): void {
    if (!this.tabs.has(id) || !this.win) return
    const prev = this.activeId != null ? this.tabs.get(this.activeId) : null
    if (prev && this.attached) this.win.contentView.removeChildView(prev.view)
    this.attached = false
    this.activeId = id
    this.layout()
    this.changed()
  }

  /** Renderer reports where the page area is; null hides the native view (e.g. while dialogs are open). */
  setBounds(b: Bounds | null): void {
    this.bounds = b
    this.layout()
  }

  private layout(): void {
    if (!this.win || this.activeId == null) return
    const t = this.tabs.get(this.activeId)!
    if (!this.bounds || this.bounds.width < 10 || this.bounds.height < 10) {
      if (this.previewTimer) {
        // Keep rendering at the usual size, off-screen: a detached view stops producing frames and a
        // tiny one would switch sites to their mobile layout under the agent.
        if (!this.attached) this.win.contentView.addChildView(t.view)
        this.attached = true
        t.view.setBounds({ x: this.win.getContentBounds().width + 64, y: 0, ...this.pageSize })
        return
      }
      if (this.attached) this.win.contentView.removeChildView(t.view)
      this.attached = false
      return
    }
    if (!this.attached) {
      this.win.contentView.addChildView(t.view)
      this.attached = true
    }
    this.pageSize = { width: Math.round(this.bounds.width), height: Math.round(this.bounds.height) }
    t.view.setBounds({
      x: Math.round(this.bounds.x),
      y: Math.round(this.bounds.y),
      width: Math.round(this.bounds.width),
      height: Math.round(this.bounds.height),
    })
  }

  active(): WebContents {
    if (this.activeId == null || !this.tabs.has(this.activeId)) this.newTab()
    return this.tabs.get(this.activeId!)!.view.webContents
  }

  tab(id: number): WebContents | null {
    return this.tabs.get(id)?.view.webContents ?? null
  }

  allTabs(): WebContents[] {
    return this.order.map((id) => this.tabs.get(id)!.view.webContents)
  }

  async navigate(url: string, wc = this.active()): Promise<void> {
    await wc.loadURL(normalizeUrl(url)).catch((err: Error) => {
      // ERR_ABORTED happens on redirects/SPA navigations and is not fatal
      if (!/ERR_ABORTED/.test(err.message)) throw err
    })
  }

  back(): void {
    const h = this.active().navigationHistory
    if (h.canGoBack()) h.goBack()
  }

  forward(): void {
    const h = this.active().navigationHistory
    if (h.canGoForward()) h.goForward()
  }

  reload(): void {
    this.active().reload()
  }

  /** Streams small frames of the active tab (`browser.preview`) while the mini window is shown. */
  setPreview(on: boolean): void {
    if (on === !!this.previewTimer) return
    if (on) {
      this.previewLast = ''
      this.previewTimer = setInterval(() => void this.previewFrame(), 500)
      this.layout()
      void this.previewFrame()
    } else {
      clearInterval(this.previewTimer!)
      this.previewTimer = null
      this.layout()
    }
  }

  /** Collapsed panel + mini window: nobody looks at the tab strip, so show the agent's tab. */
  private followAgent(): void {
    const id = this.lastControlled
    // only while an agent is still driving that tab; finished runs don't steal the active tab
    if (!this.previewTimer || this.bounds || id == null || id === this.activeId || !this.tabs.has(id) || !this.controlled.has(id)) return
    this.activate(id)
  }

  private async previewFrame(): Promise<void> {
    this.followAgent()
    const id = this.activeId
    const t = id != null ? this.tabs.get(id) : null
    if (!t || !this.attached || t.view.webContents.isDestroyed()) return
    try {
      const img = await t.view.webContents.capturePage()
      if (img.isEmpty() || !this.previewTimer) return
      const jpeg = img.resize({ width: 560, quality: 'good' }).toJPEG(72)
      const key = `${id}:${createHash('md5').update(jpeg).digest('hex')}`
      if (key === this.previewLast) return // unchanged page: nothing to send
      this.previewLast = key
      emit('browser.preview', { tabId: id!, image: `data:image/jpeg;base64,${jpeg.toString('base64')}` })
    } catch {
      /* page is navigating; next tick */
    }
  }

  async captureActive(): Promise<string | null> {
    const t = this.activeId != null ? this.tabs.get(this.activeId) : null
    if (!t || !this.attached) return null
    try {
      const img = await t.view.webContents.capturePage()
      return img.isEmpty() ? null : `data:image/jpeg;base64,${img.toJPEG(80).toString('base64')}`
    } catch {
      return null
    }
  }

  openDevTools(): void {
    this.active().openDevTools({ mode: 'detach' })
  }

  /** Makes sure the user can see what happens in the browser. */
  reveal(open = false): void {
    emit('browser.reveal', { open })
  }

  /** Marks a tab as driven (or no longer driven) by an agent: blue frame in the page, status in the UI. */
  async setControlled(wc: WebContents, on: boolean): Promise<void> {
    if (wc.isDestroyed() || this.controlled.has(wc.id) === on) return
    if (on) this.controlled.add(wc.id)
    else this.controlled.delete(wc.id)
    if (on && this.tabs.has(wc.id)) {
      this.lastControlled = wc.id // tab ids are webContents ids
      this.followAgent()
    }
    if (on) this.reveal()
    this.changed()
    await this.evalIn(wc, `window.__agent && __agent.setControlled(${on})`).catch(() => undefined)
  }

  isControlled(wc: WebContents): boolean {
    return this.controlled.has(wc.id)
  }

  /** Macro playback and other non-thread callers drive the active tab. */
  async setAgentControlled(on: boolean): Promise<void> {
    await this.setControlled(this.active(), on)
  }

  async releaseAll(): Promise<void> {
    for (const id of [...this.controlled]) {
      const wc = this.tab(id)
      if (wc) await this.setControlled(wc, false)
    }
    this.controlled.clear()
    this.changed()
  }

  /** Evaluate code in the agent isolated world, making sure the runtime is present. */
  async evalIn<T = unknown>(wc: WebContents, code: string): Promise<T> {
    const wrapped = `(async () => { ${RUNTIME_SRC} return (${code}); })()`
    return (await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: wrapped }], true)) as T
  }

  // ---------- CDP ----------
  async cdp<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      wc.debugger.on('detach', () => log.info(`[cdp] detached from ${wc.id}`))
    }
    return (await wc.debugger.sendCommand(method, params)) as T
  }

  async click(wc: WebContents, x: number, y: number, opts: { button?: 'left' | 'right'; clickCount?: number } = {}): Promise<void> {
    const base = { x, y, button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1 }
    await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  }

  async hover(wc: WebContents, x: number, y: number): Promise<void> {
    await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  }

  async insertText(wc: WebContents, text: string): Promise<void> {
    await this.cdp(wc, 'Input.insertText', { text })
  }

  async pressKey(wc: WebContents, key: string): Promise<void> {
    const def = KEYS[key] ?? { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.toUpperCase().charCodeAt(0) }
    const common = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode }
    await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: def.text })
    await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }

  async scroll(wc: WebContents, dx: number, dy: number): Promise<void> {
    await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: dx, deltaY: dy })
  }

  async screenshot(wc: WebContents, fullPage = false): Promise<string> {
    const res = await this.cdp<{ data: string }>(wc, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
      captureBeyondViewport: fullPage,
    })
    return res.data
  }

  async waitForLoad(wc: WebContents, timeout = 15000): Promise<void> {
    if (!wc.isLoading()) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, timeout)
      function done() {
        clearTimeout(t)
        wc.removeListener('did-stop-loading', done)
        resolve()
      }
      wc.once('did-stop-loading', done)
    })
  }
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return HOME
  if (/^(https?|file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`
}

export const browser = new BrowserService()
