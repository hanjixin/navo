import { createServer, type Server } from 'node:net'
import WebSocket from 'ws'
import { Bridge, type BridgeOptions } from '../src/main/external-browser/bridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../extension/manifest.json'
import { BRIDGE_PORTS, EXTENSION_ID } from '../src/shared/extension'
import { extensionIdFromKey } from '../src/main/external-browser/extension-id'

describe('extension id', () => {
  it('is derived from the manifest key', () => {
    expect(extensionIdFromKey(manifest.key)).toBe(EXTENSION_ID)
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/)
    expect(BRIDGE_PORTS).toEqual([38810, 38811, 38812, 38813, 38814, 38815, 38816, 38817, 38818, 38819])
  })
})

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const ORIGIN = `chrome-extension://${ID}`
type Msg = Record<string, unknown>

/** A fake extension: a socket plus a queue of the messages Navo sent it. */
function connect(port: number, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
  const queue: Msg[] = []
  const waiters: ((m: Msg) => void)[] = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d))
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })
  const closed = new Promise<void>((r) => ws.on('close', () => r()))
  const opened = new Promise<boolean>((r) => {
    ws.on('open', () => r(true))
    ws.on('error', () => r(false))
    ws.on('unexpected-response', () => r(false))
  })
  return {
    ws,
    opened,
    closed,
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Msg>((r) => waiters.push(r))),
  }
}

describe('Bridge', () => {
  let bridge: Bridge
  let blocker: Server | null = null
  let token: string | null = null
  const tokens = { get: () => token, set: vi.fn((t: string) => void (token = t)) }
  const make = (o: Partial<BridgeOptions> = {}) => {
    bridge = new Bridge({ ports: [39810, 39811], extensionId: ID, tokens, ...o })
    return bridge
  }

  afterEach(async () => {
    await bridge?.stop()
    blocker?.close()
    blocker = null
    token = null
    tokens.set.mockClear()
  })

  /** connects and says hello; resolves with the welcome message */
  async function hello(port: number, tok: string | null) {
    const c = connect(port)
    expect(await c.opened).toBe(true)
    c.send({ t: 'hello', version: '0.1.0', browser: 'Google Chrome', token: tok })
    return { c, welcome: await c.next() }
  }

  it('rejects connections from another origin', async () => {
    const port = await make().start()
    const c = connect(port, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(await c.opened).toBe(false)
    expect(bridge.status().connected).toBe(false)
  })

  it('pairs a new extension after the user confirms the code', async () => {
    const port = await make().start()
    const { c, welcome } = await hello(port, null)
    expect(welcome).toEqual({ t: 'welcome', app: 'navo', paired: false })
    const pair = await c.next()
    expect(pair.t).toBe('pair')
    expect(pair.code).toMatch(/^\d{6}$/)
    expect(bridge.status().pairingCode).toBe(pair.code)
    expect(bridge.link()).toBeNull()
    bridge.confirmPairing(true)
    const paired = await c.next()
    expect(paired.t).toBe('paired')
    expect(tokens.set).toHaveBeenCalledWith(paired.token)
    expect(bridge.status()).toMatchObject({ connected: true, paired: true, pairingCode: null, browser: 'Google Chrome' })
    expect(bridge.link()).not.toBeNull()
  })

  it('a rejected pairing closes the connection', async () => {
    const port = await make().start()
    const { c } = await hello(port, null)
    await c.next() // pair
    bridge.confirmPairing(false)
    await c.closed
    expect(tokens.set).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(bridge.status().connected).toBe(false))
    expect(bridge.status().pairingCode).toBeNull()
  })

  it('a known token is paired at once', async () => {
    token = 'T1'
    const port = await make().start()
    const { c, welcome } = await hello(port, 'T1')
    expect(welcome).toEqual({ t: 'welcome', app: 'navo', paired: true })
    expect(bridge.link()).not.toBeNull()
    c.send({ t: 'pong' })
    expect(bridge.status().pairingCode).toBeNull()
  })

  it('a wrong token asks to pair again', async () => {
    token = 'T1'
    const port = await make().start()
    const { c, welcome } = await hello(port, 'T2')
    expect(welcome).toEqual({ t: 'welcome', app: 'navo', paired: false })
    expect((await c.next()).t).toBe('pair')
    expect(bridge.link()).toBeNull()
  })

  it('round-trips a request and times out a silent one', async () => {
    token = 'T1'
    const port = await make({ timeoutMs: 50 }).start()
    const { c } = await hello(port, 'T1')
    const link = bridge.link()!
    const p = link.request('tabs.list')
    const req = await c.next()
    expect(req).toMatchObject({ t: 'req', method: 'tabs.list' })
    c.send({ t: 'res', id: req.id, ok: true, result: [] })
    await expect(p).resolves.toEqual([])

    await expect(link.request('tabs.list')).rejects.toThrow('超时')
    await c.next()

    const failing = link.request('tabs.close', { tabId: 1 })
    const r2 = await c.next()
    c.send({ t: 'res', id: r2.id, ok: false, error: 'x' })
    await expect(failing).rejects.toThrow('x')
  })

  it('turns away a second extension while one is linked', async () => {
    token = 'T1'
    const port = await make().start()
    await hello(port, 'T1')
    const first = bridge.link()
    const { c: second, welcome } = await hello(port, 'T1')
    expect(welcome).toEqual({ t: 'busy' })
    await second.closed
    expect(bridge.link()).toBe(first)
  })

  it('falls back to the next port when the first is taken', async () => {
    blocker = createServer()
    await new Promise<void>((r) => blocker!.listen(39810, '127.0.0.1', () => r()))
    expect(await make().start()).toBe(39811)
  })

  it('forwards events and drops the link on close', async () => {
    token = 'T1'
    const port = await make().start()
    const { c } = await hello(port, 'T1')
    const link = bridge.link()!
    const got = new Promise((r) => link.on('cdp', r))
    c.send({ t: 'evt', name: 'cdp', payload: { tabId: 7, method: 'Page.loadEventFired', params: {} } })
    expect(await got).toEqual({ tabId: 7, method: 'Page.loadEventFired', params: {} })
    const changes: boolean[] = []
    bridge.onChange((s) => changes.push(s.connected))
    c.ws.close()
    await vi.waitFor(() => expect(link.closed).toBe(true))
    expect(bridge.status().connected).toBe(false)
    expect(changes).toContain(false)
    await expect(link.request('tabs.list')).rejects.toThrow()
  })

  it('waitForLink resolves when the extension comes back', async () => {
    token = 'T1'
    const port = await make().start()
    const waiting = bridge.waitForLink(2000)
    await hello(port, 'T1')
    expect(await waiting).not.toBeNull()
    expect(await new Bridge({ ports: [39812], extensionId: ID, tokens }).waitForLink(30)).toBeNull()
  })
})
