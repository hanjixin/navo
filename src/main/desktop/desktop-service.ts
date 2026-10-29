import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { appFile } from '../core/app-dir'
import { emit } from '../core/ipc'
import { getSettings } from '../core/settings'
import type { DesktopStatus } from '@shared/types'
import { DesktopClient } from './client'
import { DesktopConsent } from './consent'
import { DesktopController } from './controller'
import { DesktopOverlay } from './overlay'

const executable = () => (app.isPackaged ? join(process.resourcesPath, 'desktop', 'navo-desktop') : appFile('dist/desktop/navo-desktop'))
// Fake mode is deliberately unavailable in packaged builds.
const fake = !app.isPackaged && process.env.NAVO_DESKTOP_FAKE === '1'
let changed: () => void = () => undefined
let abort: (threadId: string) => void = () => undefined
let reveal: () => void = () => undefined
const overlay = new DesktopOverlay(() => desktop.stop())
export const desktopConsent = new DesktopConsent({
  blocked: () => getSettings().computerUse.blockedApps,
  publish: (request) => {
    if (request) reveal()
    emit('computerUse.consent', request)
  },
})
const client = new DesktopClient({
  executable: executable(),
  args: fake ? ['--fake'] : [],
  onInput: () => desktop.stop(),
  onFailure: () => desktop.failed(),
})
export const desktop = new DesktopController({
  client,
  consent: desktopConsent,
  enabled: () => getSettings().computerUse.desktop,
  supported: () => process.platform === 'darwin' && (fake || Number(release().split('.')[0]) >= 23),
  available: () => existsSync(executable()),
  blocked: () => getSettings().computerUse.blockedApps,
  changed: (active: DesktopStatus['active']) => {
    if (active) overlay.show(active.app)
    else overlay.hide()
    changed()
  },
  abort: (threadId) => abort(threadId),
})

export function initDesktop(onChange: () => void, onAbort: (threadId: string) => void, onConsent: () => void): void {
  changed = onChange
  abort = onAbort
  reveal = onConsent
}
