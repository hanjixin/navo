import type { ApiArgs, ApiMethod, ApiResult, EventName, Events } from '../shared/ipc-contract'

declare global {
  interface Window {
    api: {
      invoke<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<Awaited<ApiResult<M>>>
      on<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void
      platform: string
      pathForFile: (file: File) => string
    }
  }
}
export {}
