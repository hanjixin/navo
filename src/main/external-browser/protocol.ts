/** Messages between Navo and its browser extension (extension/background.js speaks the same). */

export type ExtMethod = 'tabs.list' | 'tabs.create' | 'tabs.close' | 'tabs.activate' | 'debugger.attach' | 'debugger.detach' | 'cdp.send' | 'ext.reload'

export type ExtEventName = 'cdp' | 'detached' | 'tabRemoved' | 'tabUpdated' | 'handover' | 'revoke'

export type ExtToNavo =
  | { t: 'hello'; version: string; browser: string; token: string | null }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'evt'; name: ExtEventName; payload: unknown }
  | { t: 'pong' }

export type NavoToExt =
  | { t: 'welcome'; app: 'navo'; paired: boolean }
  | { t: 'pair'; code: string }
  | { t: 'paired'; token: string }
  | { t: 'busy' }
  | { t: 'req'; id: number; method: ExtMethod; params: Record<string, unknown> }
  | { t: 'ping' }

/** A tab as the extension reports it. */
export interface ExtTab {
  tabId: number
  url: string
  title: string
  active?: boolean
}
