import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app, Notification } from 'electron'
import { appFile } from '../core/app-dir'
import { emit } from '../core/ipc'
import { getSettings } from '../core/settings'
import { log } from '../core/logger'
import type { DesktopStatus } from '@shared/types'
import { t } from '@shared/i18n'
import { DesktopClient } from './client'
import { DesktopConsent } from './consent'
import { DesktopController } from './controller'
import { DesktopOverlay } from './overlay'
import { desktopExecutableName, desktopRelativePath, desktopSupported } from './platform'

const executable = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'desktop', desktopExecutableName(process.platform))
    : appFile(join('dist/desktop', desktopRelativePath(process.platform, process.arch)))
// Fake mode is deliberately unavailable in packaged builds.
const fake = !app.isPackaged && process.env.NAVO_DESKTOP_FAKE === '1'
let changed: () => void = () => undefined
let abort: (threadId: string) => void = () => undefined
const notified = new Set<string>()
const overlay = new DesktopOverlay(() => desktop.stop())
export const desktopConsent = new DesktopConsent({
  blocked: () => getSettings().computerUse.blockedApps,
  revoked: (threadId) => desktop.stop(threadId, true, 'authorization_revoked'),
  publish: (request) => {
    if (request && !notified.has(request.id)) {
      notified.add(request.id)
      if (Notification.isSupported())
        new Notification({ title: t('桌面操作等待确认'), body: t('请求操作 {{v0}}，请到确认中心处理。', { v0: request.app }) }).show()
    }
    emit('approvals.changed')
    emit('computerUse.consent', request)
  },
})
const client = new DesktopClient({
  executable: executable(),
  args: fake ? ['--fake'] : [],
  onInput: (reason) => {
    // Keep diagnostics free of app contents and input text.
    const known = ['mouse', 'mouse_button', 'keyboard', 'scroll', 'drag', 'escape', 'monitor_unavailable', 'monitor_timeout', 'monitor_disabled'].includes(
      reason,
    )
      ? reason
      : 'unknown'
    log.info(`[desktop] control stopped: ${known}`)
    desktop.stop(
      undefined,
      true,
      ['monitor_unavailable', 'monitor_timeout', 'monitor_disabled', 'unknown'].includes(known) ? 'service_failure' : 'user_takeover',
    )
  },
  onFailure: () => desktop.failed(),
})
export const desktop = new DesktopController({
  client,
  consent: desktopConsent,
  enabled: () => getSettings().computerUse.desktop,
  supported: () => desktopSupported(process.platform, release(), fake),
  platform: process.platform,
  available: () => existsSync(executable()),
  blocked: () => getSettings().computerUse.blockedApps,
  changed: (active: DesktopStatus['active']) => {
    if (active) overlay.show(active.app)
    else overlay.hide()
    changed()
  },
  abort: (threadId) => abort(threadId),
})

export function initDesktop(onChange: () => void, onAbort: (threadId: string) => void, _onConsent: () => void): void {
  changed = onChange
  abort = onAbort
}
