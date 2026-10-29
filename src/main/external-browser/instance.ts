import { BRIDGE_PORTS, EXTENSION_ID } from '@shared/extension'
import { secrets } from '../core/secrets'
import { sessions } from '../browser/agent-session'
import { browser } from '../browser/browser-service'
import { builtinDriver } from '../browser/page-driver'
import { Bridge } from './bridge'
import { ExtTabs } from './ext-tabs'
import { SANDBOX, Targets } from './targets'

/** Navo's bridge to its browser extension; the pairing token is kept in the system keychain. */
export const bridge = new Bridge({
  ports: BRIDGE_PORTS,
  extensionId: EXTENSION_ID,
  tokens: { get: () => secrets.get('extension.token'), set: (t) => secrets.set('extension.token', t) },
})

/** The tabs of the user's browser that Navo may use. */
export const extTabs = new ExtTabs((ms) => (bridge.link() ? Promise.resolve(bridge.link()) : bridge.waitForLink(ms)))

/** Which browser each conversation drives. */
export const targets = new Targets({
  tabs: extTabs,
  linked: () => !!bridge.link(),
  builtin: (threadId) => builtinDriver(threadId === SANDBOX ? browser.active() : sessions.tabFor(threadId), { agent: true }),
})
