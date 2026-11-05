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
  selected?(driver: ExternalPageDriver): void
}

/**
 * Per conversation: built-in browser (default) or a tab in the user's own browser. A conversation
 * keeps its tab in the user's browser when it switches back and forth.
 */
export class Targets {
  private mine = new Map<string, ExternalPageDriver>()
  private using = new Set<string>()
  private pending = new Map<string, Promise<ExternalPageDriver>>()
  private blocked = new Map<string, Error>()
  private closing = new Set<number>()
  private versions = new Map<string, number>()

  constructor(private deps: TargetDeps) {}

  get(threadId: string): BrowserTarget {
    return this.using.has(threadId) ? 'mine' : 'builtin'
  }

  page(threadId: string): PageDriver {
    const blocked = this.blocked.get(threadId)
    if (blocked) throw blocked
    const d = this.using.has(threadId) ? this.mine.get(threadId) : undefined
    d?.assertActive()
    return d ?? this.deps.builtin(threadId)
  }

  /** Reacquire the remembered authorized tab without changing the user's choice. */
  async beginRun(threadId: string): Promise<void> {
    if (!this.using.has(threadId)) return
    const previous = this.mine.get(threadId)
    if (!previous) return
    const version = this.versions.get(threadId) ?? 0
    try {
      await this.deps.tabs.list()
      if ((this.versions.get(threadId) ?? 0) !== version) return
      this.assertAvailable(threadId, previous.tabId)
      const driver = this.deps.tabs.driver(previous.tabId)
      driver.assertActive()
      this.mine.set(threadId, driver)
      this.blocked.delete(threadId)
      this.deps.selected?.(driver)
    } catch (error) {
      if ((this.versions.get(threadId) ?? 0) === version) this.blocked.set(threadId, error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** The conversation's tab in the user's browser, picking one if it has none (or it was closed). */
  useMine(threadId: string): Promise<ExternalPageDriver> {
    const pending = this.pending.get(threadId)
    if (pending) return pending
    const version = this.versions.get(threadId) ?? 0
    const work = this.selectMine(threadId, version)
    this.pending.set(threadId, work)
    void work
      .finally(() => {
        if (this.pending.get(threadId) === work) this.pending.delete(threadId)
      })
      .catch(() => undefined)
    return work
  }

  private async selectMine(threadId: string, version: number): Promise<ExternalPageDriver> {
    const blocked = this.blocked.get(threadId)
    if (blocked) throw blocked
    if (!this.deps.linked()) throw new NeedExtension()
    await this.deps.tabs.list()
    if ((this.versions.get(threadId) ?? 0) !== version) throw new Error('标签页选择已取消，请重新选择')
    let d = this.mine.get(threadId)
    if (!d || d.gone) {
      const previous = d
      const taken = new Set([...this.mine.entries()].filter(([t, x]) => t !== threadId && !x.gone).map(([, x]) => x.tabId))
      for (const tabId of this.closing) taken.add(tabId)
      const free = this.deps.tabs.handed().find((t) => !taken.has(t.tabId))
      if (previous && !taken.has(previous.tabId)) {
        try {
          d = this.deps.tabs.driver(previous.tabId)
        } catch {
          d = undefined
        }
      } else d = undefined
      if (!d || d.gone) d = free ? this.deps.tabs.driver(free.tabId) : await this.deps.tabs.create()
      if ((this.versions.get(threadId) ?? 0) !== version) {
        await d.detach()
        throw new Error('标签页选择已取消，请重新选择')
      }
      this.assertAvailable(threadId, d.tabId)
      this.mine.set(threadId, d)
    }
    this.using.add(threadId)
    this.deps.selected?.(d)
    return d
  }

  private assertAvailable(threadId: string, tabId: number): void {
    if (this.closing.has(tabId)) throw new Error('标签页正在关闭，请选择其他标签页')
    for (const [owner, driver] of this.mine) {
      if (owner !== threadId && driver.tabId === tabId && !driver.gone) {
        throw new Error(`标签页正由另一个对话（${owner}）使用，请先结束该对话的浏览器操作`)
      }
    }
  }

  private cancelSelection(threadId: string): void {
    this.versions.set(threadId, (this.versions.get(threadId) ?? 0) + 1)
    this.pending.delete(threadId)
  }

  /** Points the conversation at one of the usable tabs (browser_tabs switch / new). */
  useTab(threadId: string, tabId: number): ExternalPageDriver {
    this.assertAvailable(threadId, tabId)
    this.cancelSelection(threadId)
    const d = this.deps.tabs.driver(tabId)
    d.assertActive()
    this.blocked.delete(threadId)
    const prev = this.mine.get(threadId)
    if (prev && prev !== d) void prev.detach()
    this.mine.set(threadId, d)
    this.using.add(threadId)
    this.deps.selected?.(d)
    return d
  }

  async useBuiltin(threadId: string): Promise<void> {
    this.cancelSelection(threadId)
    this.using.delete(threadId)
    this.blocked.delete(threadId)
    await this.mine.get(threadId)?.detach()
  }

  /** After a run: give the tab back to the user's browser (no debugging banner), keep the choice. */
  async endRun(threadId: string): Promise<void> {
    this.cancelSelection(threadId)
    await this.mine.get(threadId)?.detach()
  }
  forget(threadId: string): void {
    this.cancelSelection(threadId)
    const driver = this.mine.get(threadId)
    this.mine.delete(threadId)
    this.using.delete(threadId)
    this.blocked.delete(threadId)
    void driver?.detach()
  }

  async close(threadId: string, tabId: number): Promise<void> {
    this.assertAvailable(threadId, tabId)
    this.closing.add(tabId)
    try {
      await this.deps.tabs.close(tabId)
    } finally {
      this.closing.delete(tabId)
    }
  }
}
