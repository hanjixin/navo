import type { WebContents } from 'electron'
import { browser } from './browser-service'
import { sessions } from './agent-session'

export type CdpFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface DialogPolicy {
  confirm: boolean
  prompt: string | null
}

/**
 * One page the browser tools drive: a tab of the built-in browser, or a tab in the user's own
 * browser reached through the Navo extension. The tools only need these operations.
 */
export interface PageDriver {
  /** 'builtin:<wc.id>' | 'ext:<tabId>' */
  readonly id: string
  readonly kind: 'builtin' | 'external'
  url(): string
  title(): string
  /** evaluates in the agent's isolated world, with the page runtime (`__agent`) in place */
  evalIn<T = unknown>(code: string): Promise<T>
  /** runs a function body in the page's main world (browser_eval) */
  evalMain<T = unknown>(script: string): Promise<T>
  cdp: CdpFn
  navigate(url: string): Promise<void>
  /** false when there is nothing to go back / forward to */
  history(action: 'back' | 'forward'): Promise<boolean>
  waitForLoad(timeout?: number): Promise<void>
  /** before each tool action: dialog takeover, the "controlled" marker */
  prepare(): Promise<void>
  /** before a screenshot: hidden tabs don't paint */
  bringToFront(): Promise<void>
  takeNotices(): string[]
  chooser(): { backendNodeId: number } | null
  clearChooser(): void
  setDialogPolicy(p: DialogPolicy): Promise<void>
}

const drivers = new WeakMap<WebContents, { agent: PageDriver; plain: PageDriver }>()

/**
 * The built-in browser's tab as a PageDriver. `agent`: the tab is driven by an agent run (or the
 * dev sandbox), so dialogs and file choosers are taken over while it works.
 */
export function builtinDriver(wc: WebContents, opts: { agent?: boolean } = {}): PageDriver {
  let cached = drivers.get(wc)
  if (!cached) {
    cached = { agent: make(wc, true), plain: make(wc, false) }
    drivers.set(wc, cached)
  }
  return opts.agent ? cached.agent : cached.plain
}

function make(wc: WebContents, agent: boolean): PageDriver {
  return {
    id: `builtin:${wc.id}`,
    kind: 'builtin',
    url: () => wc.getURL(),
    title: () => wc.getTitle(),
    evalIn: (code) => browser.evalIn(wc, code),
    evalMain: (script) => wc.executeJavaScript(`(async () => { ${script} })()`, true),
    cdp: (method, params) => browser.cdp(wc, method, params),
    navigate: (url) => browser.navigate(url, wc),
    history: async (action) => {
      const h = wc.navigationHistory
      if (action === 'back' ? !h.canGoBack() : !h.canGoForward()) return false
      if (action === 'back') h.goBack()
      else h.goForward()
      return true
    },
    waitForLoad: (timeout) => browser.waitForLoad(wc, timeout),
    prepare: async () => {
      if (agent) await sessions.prepare(wc)
      await browser.setControlled(wc, true)
    },
    bringToFront: async () => {
      if (browser.active().id !== wc.id) browser.activate(wc.id)
    },
    takeNotices: () => sessions.takeNotices(wc),
    chooser: () => {
      const c = sessions.chooser(wc)
      return c ? { backendNodeId: c.backendNodeId } : null
    },
    clearChooser: () => sessions.clearChooser(wc),
    setDialogPolicy: (p) => sessions.setPolicy(wc, p),
  }
}
