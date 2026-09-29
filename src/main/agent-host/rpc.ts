import type { RpcMessage } from './protocol'

export interface Port {
  post(msg: RpcMessage): void
  listen(fn: (msg: RpcMessage) => void): void
}

type Handler = (params: never) => unknown

/** Minimal bidirectional request/response + event channel over a message port. */
export class Rpc {
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(
    private readonly port: Port,
    private readonly handlers: Record<string, Handler>,
    private readonly onEvent: (name: string, payload: unknown) => void = () => undefined,
  ) {
    port.listen((msg) => void this.receive(msg))
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.port.post({ kind: 'req', id, method, params })
    })
  }

  emit(name: string, payload: unknown): void {
    this.port.post({ kind: 'evt', name, payload })
  }

  /** Rejects every in-flight call, e.g. when the other side died. */
  failAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  private async receive(msg: RpcMessage): Promise<void> {
    if (msg.kind === 'evt') return this.onEvent(msg.name, msg.payload)
    if (msg.kind === 'res') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
      return
    }
    const fn = this.handlers[msg.method]
    try {
      if (!fn) throw new Error(`Unknown RPC method: ${msg.method}`)
      const result = await fn(msg.params as never)
      this.port.post({ kind: 'res', id: msg.id, ok: true, result: toCloneable(result) })
    } catch (err) {
      this.port.post({ kind: 'res', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** Structured-clone safe copy (drops functions / class instances such as LangChain messages). */
function toCloneable(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v))
}
