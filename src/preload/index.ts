import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ApiArgs, ApiMethod, ApiResult, EventName, Events, IpcResult } from '@shared/ipc-contract'

const api = {
  async invoke<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<Awaited<ApiResult<M>>> {
    const res = (await ipcRenderer.invoke('api', method, args)) as IpcResult<Awaited<ApiResult<M>>>
    if (!res.ok) throw new Error(res.error)
    return res.data
  },
  on<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void {
    const listener = (_: IpcRendererEvent, payload: Events[E]) => cb(payload)
    ipcRenderer.on(`evt:${event}`, listener)
    return () => ipcRenderer.removeListener(`evt:${event}`, listener)
  },
  platform: process.platform,
  /** real path of a dropped File (File.path was removed from Electron) */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
