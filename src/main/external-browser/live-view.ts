import type { ExternalPageDriver } from './ext-tabs'

import type { LiveFrame } from '@shared/types'

export type { LiveFrame }

/**
 * Shows Navo the tab the agent is working on in the user's browser. Chrome only streams it while
 * the browser panel or the mini window is open (`watching`) and a run uses a tab there.
 */
export class LiveView {
  private watching = false
  private current: ExternalPageDriver | null = null
  private casting: ExternalPageDriver | null = null

  constructor(private send: (f: LiveFrame | null) => void) {}

  shows(d: ExternalPageDriver): boolean {
    return this.current === d
  }

  /** The agent acted on this tab: it is the one shown. */
  async use(d: ExternalPageDriver): Promise<void> {
    if (this.current === d) return
    await this.stop()
    this.current = d
    await this.sync()
  }

  async setWatching(on: boolean): Promise<void> {
    this.watching = on
    await this.sync()
  }

  /** The run ended or switched back to the built-in browser. */
  async release(d: ExternalPageDriver): Promise<void> {
    if (this.current !== d) return
    await this.stop()
    this.current = null
    this.send(null)
  }

  private async sync(): Promise<void> {
    if (!this.watching || !this.current) return this.stop()
    if (this.casting === this.current) return
    const d = this.current
    this.casting = d
    await d
      .startScreencast((image) => {
        if (this.casting === d) this.send({ tabId: d.tabId, url: d.url(), title: d.title(), image })
      })
      .catch(() => {
        if (this.casting === d) this.casting = null
      })
  }

  private async stop(): Promise<void> {
    const d = this.casting
    this.casting = null
    await d?.stopScreencast().catch(() => undefined)
  }
}
