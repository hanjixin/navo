import { join } from 'node:path'
import type { ComputerUseStatus } from '@shared/types'
import { emit } from './core/ipc'
import { log } from './core/logger'
import { paths } from './core/paths'
import { getSettings } from './core/settings'
import { bridge, targets } from './external-browser/instance'

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
        const port = await bridge.start()
        log.info(`[my-browser] waiting for the extension on 127.0.0.1:${port}`)
      } else await bridge.stop()
    } catch (err) {
      log.warn(`[my-browser] ${(err as Error).message}`)
    }
    emit('computerUse.changed', this.status())
  },

  status(): ComputerUseStatus {
    return { browser: { ...bridge.status(), extensionDir: join(paths.userData, 'browser-extension') }, desktop: null }
  },

  confirmPairing(approve: boolean): void {
    bridge.confirmPairing(approve)
  },

  /** After a run: the user's browser gets its tabs back (no debugging banner while idle). */
  endRun(threadId: string): Promise<void> {
    return targets.endRun(threadId).catch(() => undefined)
  },
}
