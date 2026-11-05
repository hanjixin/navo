import type { ExternalPageDriver } from './ext-tabs'
import type { LiveFrame } from '@shared/types'
import type { ExternalViewState } from '@shared/external-view'
export type { LiveFrame }

/** Observer only: retry never selects a new control object or replays an agent action. */
export class LiveView {
  private watching = false
  private selection = 0
  private current: ExternalPageDriver | null = null
  private unwatch: (() => void) | null = null
  private casting: ExternalPageDriver | null = null
  private connected = true
  private retrying: Promise<void> | null = null
  private view: ExternalViewState = { status: 'released', tabId: null, browser: null, title: '', url: '' }

  constructor(
    private send: (f: LiveFrame | null) => void,
    private changed: (state: ExternalViewState) => void = () => {},
    private synchronize?: () => Promise<string | null>,
  ) {}

  state(): ExternalViewState {
    return { ...this.view }
  }
  private publish(status: ExternalViewState['status'], error?: string): void {
    const next = { ...this.view, status, error, ...(this.current ? { tabId: this.current.tabId, title: this.current.title(), url: this.current.url() } : {}) }
    if (JSON.stringify(next) === JSON.stringify(this.view)) return
    this.view = next
    this.changed(this.state())
  }
  private async authorize(): Promise<boolean> {
    if (!this.synchronize) return true
    try {
      const browser = await this.synchronize()
      this.connected = true
      this.view.browser = browser ?? this.view.browser
      return !!this.current && !this.current.gone
    } catch (error) {
      if (this.current) this.publish(this.connected ? 'error' : 'disconnected', error instanceof Error ? error.message : String(error))
      return false
    }
  }
  shows(d: ExternalPageDriver): boolean {
    return this.current === d
  }

  async connection(connected: boolean, browser: string | null): Promise<void> {
    this.connected = connected
    this.view.browser = browser ?? this.view.browser
    if (!this.current) return
    if (!connected) {
      this.publish('disconnected')
      await this.stop()
    } else await this.retry()
  }

  async use(d: ExternalPageDriver): Promise<void> {
    if (this.current === d) return
    const selection = ++this.selection
    await this.stop()
    if (selection !== this.selection) return
    this.current = d
    this.send(null)
    this.unwatch?.()
    this.unwatch = d.onInvalidated(() => {
      if (this.current !== d) return
      this.publish('released')
      this.current = null
      this.casting = null
    })
    if (d.gone) {
      this.publish('released')
      this.current = null
      return
    }
    this.publish(this.connected ? 'connecting' : 'disconnected')
    if (await this.authorize()) await this.sync()
  }

  async setWatching(on: boolean): Promise<void> {
    this.watching = on
    await this.sync()
  }

  async release(d: ExternalPageDriver): Promise<void> {
    if (this.current !== d) return
    ++this.selection
    this.publish('released')
    this.current = null
    this.unwatch?.()
    this.unwatch = null
    await this.stop()
  }

  retry(): Promise<void> {
    if (this.retrying) return this.retrying
    const work = (async () => {
      if (!this.current || this.current.gone) return
      this.current.assertActive()
      await this.stop()
      if (await this.authorize()) await this.sync()
    })()
    this.retrying = work
    void work
      .finally(() => {
        if (this.retrying === work) this.retrying = null
      })
      .catch(() => {})
    return work
  }

  async focus(): Promise<void> {
    if (!this.connected || !this.current || this.current.gone) throw new Error('标签页已释放或浏览器已断线')
    this.current.assertActive()
    await this.current.bringToFront()
  }

  private async sync(): Promise<void> {
    if (!this.watching || !this.current || !this.connected) return this.stop()
    if (this.casting === this.current) return
    const d = this.current
    this.casting = d
    this.publish('connecting')
    await d
      .startScreencast((image) => {
        if (this.casting !== d || !this.connected || d.gone) return
        this.send({ tabId: d.tabId, url: d.url(), title: d.title(), image })
        this.publish('live')
      })
      .catch((error) => {
        if (this.casting !== d) return
        this.casting = null
        this.publish(this.connected ? 'error' : 'disconnected', String(error instanceof Error ? error.message : error))
      })
  }

  private async stop(): Promise<void> {
    const d = this.casting
    this.casting = null
    await d?.stopScreencast().catch(() => undefined)
  }
}
