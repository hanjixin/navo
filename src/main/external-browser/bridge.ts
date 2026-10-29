import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ExtEventName, ExtMethod, ExtToNavo, NavoToExt } from './protocol'

/** A paired connection to the extension. */
export interface Link {
  readonly browser: string
  request<T = unknown>(method: ExtMethod, params?: Record<string, unknown>): Promise<T>
  on<P = unknown>(name: ExtEventName, fn: (payload: P) => void): () => void
  readonly closed: boolean
}

export interface BridgeStatus {
  connected: boolean
  paired: boolean
  browser: string | null
  pairingCode: string | null
}

export interface BridgeOptions {
  ports: number[]
  extensionId: string
  tokens: { get(): string | null; set(token: string): void }
  /** per request; default 15000 */
  timeoutMs?: number
  /** keeps the extension's service worker alive; default 20000 */
  pingMs?: number
}

/** an unpaired connection is closed when the user hasn't confirmed the code by then */
const PAIRING_MS = 60_000

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

class Connection implements Link {
  closed = false
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private listeners = new Map<ExtEventName, Set<(p: unknown) => void>>()

  constructor(
    readonly ws: WebSocket,
    readonly browser: string,
    private timeoutMs: number,
  ) {}

  send(msg: NavoToExt): void {
    if (!this.closed) this.ws.send(JSON.stringify(msg))
  }

  request<T = unknown>(method: ExtMethod, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('与浏览器扩展的连接已断开'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`浏览器扩展响应超时（${method}）`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.send({ t: 'req', id, method, params })
    })
  }

  on<P = unknown>(name: ExtEventName, fn: (payload: P) => void): () => void {
    let set = this.listeners.get(name)
    if (!set) this.listeners.set(name, (set = new Set()))
    const f = fn as (p: unknown) => void
    set.add(f)
    return () => set.delete(f)
  }

  handle(msg: ExtToNavo): void {
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    } else if (msg.t === 'evt') {
      for (const fn of this.listeners.get(msg.name) ?? []) fn(msg.payload)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('与浏览器扩展的连接已断开'))
    }
    this.pending.clear()
  }
}

/**
 * Navo's end of the extension link: a WebSocket server on 127.0.0.1 that only the Navo extension
 * (checked by Origin) may use, and only after the user confirmed a pairing code once.
 */
export class Bridge {
  private server: WebSocketServer | null = null
  private linked: Connection | null = null
  /** the connection waiting for the user to confirm its code */
  private pairing: { ws: WebSocket; browser: string; code: string; timer: NodeJS.Timeout } | null = null
  private changeFns = new Set<(s: BridgeStatus) => void>()
  private linkWaiters = new Set<(l: Link) => void>()
  private pingTimer: NodeJS.Timeout | null = null

  constructor(private opts: BridgeOptions) {}

  async start(): Promise<number> {
    if (this.server) return (this.server.address() as { port: number }).port
    for (const port of this.opts.ports) {
      const server = await this.listen(port)
      if (!server) continue
      this.server = server
      server.on('connection', (ws) => this.accept(ws))
      this.pingTimer = setInterval(() => this.linked?.send({ t: 'ping' }), this.opts.pingMs ?? 20_000)
      return port
    }
    throw new Error(`本机端口 ${this.opts.ports[0]}–${this.opts.ports.at(-1)} 都被占用，无法连接浏览器扩展`)
  }

  private listen(port: number): Promise<WebSocketServer | null> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port,
        verifyClient: ({ origin }: { origin: string; req: IncomingMessage }) => origin === `chrome-extension://${this.opts.extensionId}`,
      })
      server.once('listening', () => resolve(server))
      server.once('error', () => {
        server.close()
        resolve(null)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    const server = this.server
    this.server = null
    if (!server) return
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }

  link(): Link | null {
    return this.linked && !this.linked.closed ? this.linked : null
  }

  waitForLink(ms: number): Promise<Link | null> {
    const now = this.link()
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => {
      const done = (l: Link | null) => {
        clearTimeout(timer)
        this.linkWaiters.delete(done)
        resolve(l)
      }
      const timer = setTimeout(() => done(null), ms)
      this.linkWaiters.add(done)
    })
  }

  status(): BridgeStatus {
    const l = this.link()
    return {
      connected: !!l || !!this.pairing,
      paired: !!l,
      browser: l?.browser ?? this.pairing?.browser ?? null,
      pairingCode: this.pairing?.code ?? null,
    }
  }

  onChange(fn: (s: BridgeStatus) => void): () => void {
    this.changeFns.add(fn)
    return () => this.changeFns.delete(fn)
  }

  confirmPairing(approve: boolean): void {
    const p = this.pairing
    if (!p) return
    clearTimeout(p.timer)
    this.pairing = null
    if (!approve || this.link()) {
      p.ws.close()
      return this.changed()
    }
    const token = randomBytes(32).toString('hex')
    this.opts.tokens.set(token)
    p.ws.send(JSON.stringify({ t: 'paired', token } satisfies NavoToExt))
    this.adopt(p.ws, p.browser)
  }

  private changed(): void {
    const s = this.status()
    for (const fn of this.changeFns) fn(s)
  }

  private accept(ws: WebSocket): void {
    let conn: Connection | null = null
    const send = (m: NavoToExt) => ws.send(JSON.stringify(m))
    ws.on('message', (data) => {
      let msg: ExtToNavo
      try {
        msg = JSON.parse(String(data)) as ExtToNavo
      } catch {
        return
      }
      if (conn) return conn.handle(msg)
      if (msg.t !== 'hello') return
      if (this.link()) {
        send({ t: 'busy' })
        return ws.close()
      }
      const known = this.opts.tokens.get()
      if (known && typeof msg.token === 'string' && sameToken(msg.token, known)) {
        send({ t: 'welcome', app: 'navo', paired: true })
        conn = this.adopt(ws, msg.browser)
        return
      }
      send({ t: 'welcome', app: 'navo', paired: false })
      // a newer pairing request replaces one the user never answered
      if (this.pairing) {
        clearTimeout(this.pairing.timer)
        this.pairing.ws.close()
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      this.pairing = { ws, browser: msg.browser, code, timer: setTimeout(() => this.confirmPairing(false), PAIRING_MS) }
      send({ t: 'pair', code })
      this.changed()
    })
    ws.on('close', () => {
      if (this.pairing?.ws === ws) {
        clearTimeout(this.pairing.timer)
        this.pairing = null
        this.changed()
      }
      const c = conn ?? (this.linked?.ws === ws ? this.linked : null)
      if (c) {
        c.close()
        if (this.linked === c) this.linked = null
        this.changed()
      }
    })
    ws.on('error', () => undefined)
  }

  private adopt(ws: WebSocket, browser: string): Connection {
    const conn = new Connection(ws, browser, this.opts.timeoutMs ?? 15_000)
    this.linked = conn
    // messages after pairing go to the connection (accept()'s handler looks it up through `linked`)
    ws.removeAllListeners('message')
    ws.on('message', (data) => {
      try {
        conn.handle(JSON.parse(String(data)) as ExtToNavo)
      } catch {
        /* malformed */
      }
    })
    for (const fn of [...this.linkWaiters]) fn(conn)
    this.changed()
    return conn
  }
}
