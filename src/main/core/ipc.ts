import { BrowserWindow, ipcMain } from 'electron'
import type { Api, ApiMethod, EventName, Events, IpcResult } from '@shared/ipc-contract'
import { log } from './logger'

type Handler<M extends ApiMethod> = (...args: Parameters<Api[M]>) => ReturnType<Api[M]> | Promise<ReturnType<Api[M]>>

const handlers = new Map<string, (...args: unknown[]) => unknown>()

export function handle<M extends ApiMethod>(method: M, fn: Handler<M>): void {
  handlers.set(method, fn as (...args: unknown[]) => unknown)
}

export function handleAll(map: { [M in ApiMethod]?: Handler<M> }): void {
  for (const [k, fn] of Object.entries(map)) handlers.set(k, fn as (...args: unknown[]) => unknown)
}

export function registerIpc(): void {
  ipcMain.handle('api', async (_e, method: string, args: unknown[]): Promise<IpcResult<unknown>> => {
    const fn = handlers.get(method)
    if (!fn) return { ok: false, error: `Unknown method: ${method}` }
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`[ipc] ${method} failed: ${message}`)
      return { ok: false, error: message }
    }
  })
}

export function emit<E extends EventName>(event: E, payload?: Events[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(`evt:${event}`, payload)
  }
}
