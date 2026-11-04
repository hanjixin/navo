import { describe, expect, it, vi } from 'vitest'
import type { Link } from '../src/main/external-browser/bridge'
import { ExtensionReload } from '../src/main/external-browser/reload'

function setup() {
  let current: Pick<Link, 'closed' | 'request'> | null = null
  const failure = vi.fn()
  const reloader = new ExtensionReload(() => current, failure)
  const request = vi.fn(async () => undefined) as unknown as Link['request']
  return { reloader, failure, request, connect: (closed = false) => (current = { closed, request }), disconnect: () => (current = null) }
}

describe('extension reload after bundle update', () => {
  it('remembers an offline update and reloads once on the next usable connection', () => {
    const h = setup()
    h.reloader.updated(true, true)
    h.reloader.updated(true, false)
    h.connect(true)
    h.reloader.connected()
    expect(h.request).not.toHaveBeenCalled()
    h.connect()
    h.reloader.connected()
    expect(h.request).toHaveBeenCalledExactlyOnceWith('ext.reload')
    h.disconnect()
    h.reloader.connected()
    h.connect()
    h.reloader.connected()
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  it('does not reload first installations or unchanged copies', () => {
    const h = setup()
    h.reloader.updated(false, true)
    h.connect()
    h.reloader.connected()
    h.reloader.updated(true, false)
    expect(h.request).not.toHaveBeenCalled()
  })

  it('reloads an existing connected copy immediately', () => {
    const h = setup()
    h.connect()
    h.reloader.updated(true, true)
    expect(h.request).toHaveBeenCalledExactlyOnceWith('ext.reload')
  })

  it('logs a failed attempt without entering a disconnect reload loop', async () => {
    const failure = vi.fn()
    const request = vi.fn().mockRejectedValue(new Error('disconnected')) as Link['request']
    const reloader = new ExtensionReload(() => ({ closed: false, request }), failure)
    reloader.updated(true, true)
    await Promise.resolve()
    expect(failure).toHaveBeenCalledOnce()
    reloader.connected()
    expect(request).toHaveBeenCalledOnce()
  })
})
