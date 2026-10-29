import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import type { ComputerUseStatus } from '@shared/types'
import { appFile } from './core/app-dir'
import { emit } from './core/ipc'
import { log } from './core/logger'
import { paths } from './core/paths'
import { getSettings } from './core/settings'
import { installExtension, type InstallResult } from './external-browser/install'
import { bridge, targets } from './external-browser/instance'

const extensionDir = () => join(paths.userData, 'browser-extension')
const bundledExtension = () => (app.isPackaged ? join(process.resourcesPath, 'extension') : appFile('dist/extension'))

const EXTENSION_PAGES = {
  chrome: { app: 'Google Chrome', url: 'chrome://extensions' },
  edge: { app: 'Microsoft Edge', url: 'edge://extensions' },
} as const

/** Computer use: the agent working in the user's own browser (through the Navo extension). */
export const computerUse = {
  init(): void {
    bridge.onChange(() => emit('computerUse.changed', this.status()))
    void this.apply()
  },

  /** Starts or stops the extension bridge to match the settings. */
  async apply(): Promise<void> {
    try {
      if (getSettings().computerUse.myBrowser) {
        this.ensureExtension()
        const port = await bridge.start()
        log.info(`[my-browser] waiting for the extension on 127.0.0.1:${port}`)
      } else await bridge.stop()
    } catch (err) {
      log.warn(`[my-browser] ${(err as Error).message}`)
    }
    emit('computerUse.changed', this.status())
  },

  /** Puts the extension in its fixed folder; a connected extension reloads to pick up a new version. */
  ensureExtension(): InstallResult {
    const res = installExtension(bundledExtension(), extensionDir())
    if (res.updated)
      void bridge
        .link()
        ?.request('ext.reload')
        .catch(() => undefined)
    return res
  },

  status(): ComputerUseStatus {
    return { browser: { ...bridge.status(), extensionDir: extensionDir() }, desktop: null }
  },

  confirmPairing(approve: boolean): void {
    bridge.confirmPairing(approve)
  },

  /** Opens the browser's extensions page (where "Load unpacked" is). chrome:// can't always be opened from outside. */
  openExtensionsPage(browser: 'chrome' | 'edge' | 'other'): Promise<{ opened: boolean; url: string }> {
    if (browser === 'other' || process.platform !== 'darwin') return Promise.resolve({ opened: false, url: 'chrome://extensions' })
    const page = EXTENSION_PAGES[browser]
    return new Promise((resolve) => execFile('open', ['-a', page.app, page.url], (err) => resolve({ opened: !err, url: page.url })))
  },

  /** After a run: the user's browser gets its tabs back (no debugging banner while idle). */
  endRun(threadId: string): Promise<void> {
    return targets.endRun(threadId).catch(() => undefined)
  },
}
