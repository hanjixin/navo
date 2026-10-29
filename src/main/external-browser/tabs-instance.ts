import { ExtTabs } from './ext-tabs'
import { bridge } from './instance'

/** The tabs of the user's browser that Navo may use, over the app's bridge. */
export const extTabs = new ExtTabs((ms) => (bridge.link() ? Promise.resolve(bridge.link()) : bridge.waitForLink(ms)))
