import { describe, expect, it } from 'vitest'
import type { RpcMessage } from '../src/main/agent-host/protocol'
import { Rpc, type Port } from '../src/main/agent-host/rpc'

/** Two in-memory ports wired to each other, delivering asynchronously like a real MessagePort. */
function pair(): [Port, Port] {
  const listeners: ((m: RpcMessage) => void)[][] = [[], []]
  const make = (self: number, other: number): Port => ({
    post: (m) => setTimeout(() => listeners[other].forEach((fn) => fn(structuredClone(m)))),
    listen: (fn) => void listeners[self].push(fn),
  })
  return [make(0, 1), make(1, 0)]
}

describe('Rpc', () => {
  it('round-trips requests in both directions and forwards events', async () => {
    const [a, b] = pair()
    const events: unknown[] = []
    const main = new Rpc(a, { 'tool.call': (p: { x: number }) => p.x * 2 }, (name, payload) => events.push([name, payload]))
    const host = new Rpc(b, { ping: () => 'pong' })
    expect(await main.call('ping', null)).toBe('pong')
    expect(await host.call('tool.call', { x: 21 })).toBe(42)
    host.emit('chat.event', { type: 'token' })
    await new Promise((r) => setTimeout(r, 5))
    expect(events).toEqual([['chat.event', { type: 'token' }]])
  })

  it('propagates handler errors and unknown methods as rejections', async () => {
    const [a, b] = pair()
    const main = new Rpc(a, {})
    new Rpc(b, {
      boom: () => {
        throw new Error('bad things')
      },
    })
    await expect(main.call('boom', null)).rejects.toThrow('bad things')
    await expect(main.call('nope', null)).rejects.toThrow('Unknown RPC method: nope')
  })

  it('failAll rejects in-flight calls (e.g. when the agent process dies)', async () => {
    const [a] = pair()
    const main = new Rpc(a, {})
    const pending = main.call('never', null)
    main.failAll('agent exited')
    await expect(pending).rejects.toThrow('agent exited')
  })

  it('results are made structured-clone safe', async () => {
    const [a, b] = pair()
    const main = new Rpc(a, {})
    new Rpc(b, { obj: () => ({ keep: 1, fn: () => 1, nested: { d: new Date(0) } }) })
    expect(await main.call('obj', null)).toEqual({ keep: 1, nested: { d: '1970-01-01T00:00:00.000Z' } })
  })
})
