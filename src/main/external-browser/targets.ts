import type { PageDriver } from '../browser/page-driver'
import type { ExternalPageDriver, ExtTabs } from './ext-tabs'

/** Which browser a conversation's browser_* tools drive. */
export type BrowserTarget = 'builtin' | 'mine'

/** the "conversation" of the developer tools' sandbox (dev.invokeTool) */
export const SANDBOX = '__sandbox__'

/** The Navo extension isn't connected: the user has to import / open it first. */
export class NeedExtension extends Error {
  constructor() {
    super('用户还没有连接 Navo 浏览器扩展')
  }
}

export interface TargetDeps {
  tabs: ExtTabs
  /** whether a paired extension is connected right now */
  linked(): boolean
  /** the conversation's page in the built-in browser */
  builtin(threadId: string): PageDriver
}

/**
 * Per conversation: built-in browser (default) or a tab in the user's own browser. A conversation
 * keeps its tab in the user's browser when it switches back and forth.
 */
export class Targets {
  private mine = new Map<string, ExternalPageDriver>()
  private using = new Set<string>()

  constructor(private deps: TargetDeps) {}

  get(threadId: string): BrowserTarget {
    return this.using.has(threadId) ? 'mine' : 'builtin'
  }

  page(threadId: string): PageDriver {
    const d = this.using.has(threadId) ? this.mine.get(threadId) : undefined
    return d ?? this.deps.builtin(threadId)
  }

  /** The conversation's tab in the user's browser, picking one if it has none (or it was closed). */
  async useMine(threadId: string): Promise<ExternalPageDriver> {
    if (!this.deps.linked()) throw new NeedExtension()
    let d = this.mine.get(threadId)
    if (!d || d.gone) {
      const taken = new Set([...this.mine.entries()].filter(([t, x]) => t !== threadId && !x.gone).map(([, x]) => x.tabId))
      const free = this.deps.tabs.handed().find((t) => !taken.has(t.tabId))
      d = free ? this.deps.tabs.driver(free.tabId) : await this.deps.tabs.create()
      this.mine.set(threadId, d)
    }
    this.using.add(threadId)
    return d
  }

  /** Points the conversation at one of the usable tabs (browser_tabs switch / new). */
  useTab(threadId: string, tabId: number): ExternalPageDriver {
    const d = this.deps.tabs.driver(tabId)
    const prev = this.mine.get(threadId)
    if (prev && prev !== d) void prev.detach()
    this.mine.set(threadId, d)
    this.using.add(threadId)
    return d
  }

  async useBuiltin(threadId: string): Promise<void> {
    this.using.delete(threadId)
    await this.mine.get(threadId)?.detach()
  }

  /** After a run: give the tab back to the user's browser (no debugging banner), keep the choice. */
  async endRun(threadId: string): Promise<void> {
    await this.mine.get(threadId)?.detach()
  }
}
