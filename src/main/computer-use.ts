import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import type { ComputerUseStatus } from '@shared/types'
import { t } from '@shared/i18n'
import { appFile } from './core/app-dir'
import { kv } from './core/db'
import { emit } from './core/ipc'
import { log } from './core/logger'
import { paths } from './core/paths'
import { getSettings } from './core/settings'
import { installExtension, type InstallResult } from './external-browser/install'
import { ExternalPageDriver } from './external-browser/ext-tabs'
import { bridge, liveView, targets } from './external-browser/instance'

const defaultDir = () => join(paths.userData, 'browser-extension')
/** a copy the user put somewhere they can pick in Chrome's folder dialog (~/Library is hidden there) */
const exportedDir = () => kv.get<string | null>('extension.exportDir', null)
/** the folder to load in Chrome: the user's own copy when there is one */
const extensionDir = () => {
  const dir = exportedDir()
  return dir && existsSync(join(dir, 'manifest.json')) ? dir : defaultDir()
}
let watchers = 0
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
    const res = installExtension(bundledExtension(), defaultDir())
    // the user's copy follows new versions too (the folder they loaded stays the same)
    const dir = exportedDir()
    if (dir && existsSync(dir)) {
      try {
        if (installExtension(bundledExtension(), dir).updated) res.updated = true
      } catch (err) {
        log.warn(`[my-browser] couldn't update the extension in ${dir}: ${(err as Error).message}`)
      }
    }
    if (res.updated)
      void bridge
        .link()
        ?.request('ext.reload')
        .catch(() => undefined)
    return res
  },

  /** Copies the extension into a folder the user picks (a "Navo 扩展" folder inside it). */
  async exportExtension(): Promise<{ dir: string } | null> {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: t('导出 Navo 浏览器扩展'),
      buttonLabel: t('导出到这里'),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths[0]) return null
    const dir = join(picked.filePaths[0], 'Navo 扩展')
    installExtension(bundledExtension(), dir)
    kv.set('extension.exportDir', dir)
    emit('computerUse.changed', this.status())
    return { dir }
  },

  /** The browser panel or the mini window opened / closed: stream the agent's tab only while one is shown. */
  watch(on: boolean): void {
    watchers = Math.max(0, watchers + (on ? 1 : -1))
    void liveView.setWatching(watchers > 0)
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
  async endRun(threadId: string): Promise<void> {
    const page = targets.get(threadId) === 'mine' ? targets.page(threadId) : null
    if (page instanceof ExternalPageDriver) await liveView.release(page)
    await targets.endRun(threadId).catch(() => undefined)
  },
}
