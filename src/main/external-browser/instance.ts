import { BRIDGE_PORTS, EXTENSION_ID } from '@shared/extension'
import { secrets } from '../core/secrets'
import { sessions } from '../browser/agent-session'
import { browser } from '../browser/browser-service'
import { builtinDriver } from '../browser/page-driver'
import { Bridge } from './bridge'
import { ExtTabs } from './ext-tabs'
import { SANDBOX, Targets } from './targets'
import { LiveView } from './live-view'
import { emit } from '../core/ipc'

/** Navo's bridge to its browser extension; the pairing token is kept in the system keychain. */
/** NAVO_BRIDGE_PORT: tests use their own range, so an extension in the developer's real browser can't join */
const testPort = Number(process.env.NAVO_BRIDGE_PORT) || 0

export const bridge = new Bridge({
  ports: testPort ? [testPort] : BRIDGE_PORTS,
  extensionId: EXTENSION_ID,
  tokens: { get: () => secrets.get('extension.token'), set: (t) => secrets.set('extension.token', t) },
})

/** The tabs of the user's browser that Navo may use. */
export const extTabs = new ExtTabs((ms) => (bridge.link() ? Promise.resolve(bridge.link()) : bridge.waitForLink(ms)))

/** Which browser each conversation drives. */
export const targets = new Targets({
  tabs: extTabs,
  linked: () => !!bridge.link(),
  selected: (driver) => {
    emit('browser.reveal', { open: false })
    void liveView.use(driver)
  },
  builtin: (threadId) => builtinDriver(threadId === SANDBOX ? browser.active() : sessions.tabFor(threadId), { agent: true }),
})

/** The picture of the agent's tab in the user's browser, for Navo's browser panel. */
export const liveView = new LiveView(
  (f) => emit('computerUse.frame', f),
  (state) => emit('computerUse.viewChanged', state),
  async () => {
    const link = bridge.link()
    if (!link) throw new Error('与浏览器扩展的连接已断开')
    await extTabs.list()
    if (bridge.link() !== link) throw new Error('浏览器连接已变化，请重试')
    return link.browser
  },
)

// Synchronize authorizations before resuming observation on a fresh connection.
let connectionVersion = 0
bridge.onChange((state) => {
  const version = ++connectionVersion
  if (!state.paired) {
    void liveView.connection(false, state.browser)
    return
  }
  void extTabs
    .list()
    .then(() => {
      if (version === connectionVersion) return liveView.connection(true, state.browser)
    })
    .catch(() => {
      if (version === connectionVersion) void liveView.connection(!!bridge.link(), state.browser)
    })
})
