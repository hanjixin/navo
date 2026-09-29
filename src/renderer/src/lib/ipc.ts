import type { ApiArgs, ApiMethod, ApiResult, EventName, Events } from '@shared/ipc-contract'

export function call<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<Awaited<ApiResult<M>>> {
  return window.api.invoke(method, ...args)
}

export function on<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void {
  return window.api.on(event, cb)
}
