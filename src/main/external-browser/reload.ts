import type { Link } from './bridge'

/** An installed copy may change before the startup bridge has a connection. */
export class ExtensionReload {
  private pending = false

  constructor(
    private getLink: () => Pick<Link, 'closed' | 'request'> | null,
    private onFailure: (error: unknown) => void,
  ) {}

  updated(wasInstalled: boolean, changed: boolean): void {
    if (wasInstalled && changed) this.pending = true
    this.connected()
  }

  connected(): void {
    const link = this.getLink()
    if (!this.pending || !link || link.closed) return
    // Consume before dispatch: the resulting disconnect/reconnect must not reload again.
    this.pending = false
    void link.request('ext.reload').catch(this.onFailure)
  }
}
