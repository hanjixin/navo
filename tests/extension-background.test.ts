import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function deferred() {
  let resolve!: (value?: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness(initialOwned: number[] = []) {
  const listeners: Record<string, (...args: unknown[]) => unknown> = {}
  const listener = (name: string) => ({
    addListener: (fn: (...args: unknown[]) => unknown) => {
      listeners[name] = fn
    },
  })
  let handed = [1]
  let owned: number[] = initialOwned
  const chrome = {
    action: { setBadgeText: vi.fn() },
    runtime: {
      sendMessage: async () => {},
      getManifest: () => ({ version: '1' }),
      reload: vi.fn(),
      onMessage: listener('popup'),
      onStartup: listener('startup'),
      onInstalled: listener('installed'),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: vi.fn(async () => ({ handed, owned })),
        set: async (value: { handed?: number[]; owned?: number[] }) => {
          if (value.handed) handed = value.handed
          if (value.owned) owned = value.owned
        },
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => ({ id })),
      query: vi.fn(async () => [{ id: 1 }]),
      create: vi.fn(async () => ({ id: 2 })),
      remove: vi.fn(async () => {}),
      update: vi.fn(async () => ({ windowId: 5 })),
      onRemoved: listener('removed'),
      onUpdated: listener('updated'),
    },
    windows: { update: vi.fn(async () => {}) },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      onEvent: listener('cdp'),
      onDetach: listener('detach'),
    },
    alarms: { create: vi.fn(), onAlarm: listener('alarm') },
  }
  const context = { chrome, navigator: {}, WebSocket: { OPEN: 1 }, setTimeout: vi.fn(), clearTimeout: vi.fn() }
  const source = readFileSync('extension/background.js', 'utf8').replace(/void connect\(\)\s*$/, '')
  const api = runInNewContext(
    source +
      `
    ;({
      link(sock) { ws = sock; state = 'linked' },
      request(sock, method, params = {}, id = 1) { return onMessage(JSON.stringify({t:'req', id, method, params}), sock) },
      close: onClose,
      state() { return state }
    })
  `,
    context,
  )
  const socket = () => ({ readyState: 1, send: vi.fn(), close: vi.fn() })
  return { api, chrome, listeners, socket }
}

describe('browser extension connection isolation', () => {
  it('does not send an old response to a new socket with the same request id', async () => {
    const h = harness()
    const gate = deferred()
    const old = h.socket(),
      next = h.socket()
    h.api.link(old)
    h.chrome.tabs.query.mockImplementationOnce(() => gate.promise as never)
    const pending = h.api.request(old, 'tabs.list')
    await vi.waitFor(() => expect(h.chrome.tabs.query).toHaveBeenCalledTimes(1))
    h.api.close(old)
    h.api.link(next)
    await h.api.request(next, 'tabs.list')
    gate.resolve([{ id: 1 }])
    await pending
    expect(old.send).not.toHaveBeenCalled()
    expect(next.send).toHaveBeenCalledTimes(1)
  })

  it('ignores old socket close after a new socket is linked', async () => {
    const h = harness(),
      old = h.socket(),
      next = h.socket()
    h.api.link(old)
    h.api.link(next)
    h.api.close(old)
    await h.api.request(next, 'tabs.list')
    expect(h.api.state()).toBe('linked')
    expect(next.send).toHaveBeenCalledTimes(1)
  })

  it('detaches on disconnect and waits for cleanup before reattaching', async () => {
    const h = harness(),
      old = h.socket(),
      next = h.socket()
    h.api.link(old)
    await h.api.request(old, 'debugger.attach', { tabId: 1 })
    const cleanup = deferred()
    h.chrome.debugger.detach.mockImplementationOnce(() => cleanup.promise as never)
    h.api.close(old)
    h.api.link(next)
    const pending = h.api.request(next, 'debugger.attach', { tabId: 1 })
    await vi.waitFor(() => expect(h.chrome.debugger.detach).toHaveBeenCalledTimes(1))
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1)
    cleanup.resolve()
    await pending
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(2)
  })

  it('cleans up an attach that finishes after disconnect', async () => {
    const h = harness(),
      old = h.socket(),
      next = h.socket()
    const gate = deferred()
    h.chrome.debugger.attach.mockImplementationOnce(() => gate.promise as never)
    h.api.link(old)
    const pending = h.api.request(old, 'debugger.attach', { tabId: 1 })
    await vi.waitFor(() => expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1))
    h.api.close(old)
    h.api.link(next)
    const fresh = h.api.request(next, 'debugger.attach', { tabId: 1 })
    gate.resolve()
    await Promise.all([pending, fresh])
    expect(h.chrome.debugger.detach).toHaveBeenCalledTimes(1)
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(2)
    expect(old.send).not.toHaveBeenCalled()
  })

  it('revokes pending attach and blocks subsequent commands immediately', async () => {
    const h = harness(),
      sock = h.socket()
    const gate = deferred()
    h.chrome.debugger.attach.mockImplementationOnce(() => gate.promise as never)
    h.api.link(sock)
    const pending = h.api.request(sock, 'debugger.attach', { tabId: 1 })
    await vi.waitFor(() => expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1))
    const reply = vi.fn()
    h.listeners.popup({ t: 'revoke', tabId: 1 }, {}, reply)
    gate.resolve()
    await pending
    await h.api.request(sock, 'cdp.send', { tabId: 1, method: 'Input.dispatchMouseEvent' })
    expect(h.chrome.debugger.detach).toHaveBeenCalledTimes(1)
    expect(h.chrome.debugger.sendCommand).not.toHaveBeenCalled()
    expect(sock.send.mock.calls.map(([raw]) => JSON.parse(raw)).some((msg) => msg.name === 'revoke')).toBe(true)
  })

  it('coalesces concurrent attaches and rejects unhanded tabs', async () => {
    const h = harness(),
      sock = h.socket()
    h.api.link(sock)
    await Promise.all([h.api.request(sock, 'debugger.attach', { tabId: 1 }), h.api.request(sock, 'debugger.attach', { tabId: 1 })])
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1)
    await h.api.request(sock, 'tabs.close', { tabId: 99 })
    expect(h.chrome.tabs.remove).not.toHaveBeenCalled()
  })
  it('restores created-tab authorization from session storage after worker restart', async () => {
    const h = harness([2]),
      sock = h.socket()
    h.api.link(sock)
    await h.api.request(sock, 'debugger.attach', { tabId: 2 })
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1)
    await new Promise<void>((resolve) => h.listeners.popup({ t: 'revoke', tabId: 2 }, {}, resolve))
    await h.api.request(sock, 'debugger.attach', { tabId: 2 })
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect((await h.chrome.storage.session.get()).owned).toEqual([])
  })

  it('detaches even while a CDP command is waiting for completion', async () => {
    const h = harness(),
      sock = h.socket(),
      command = deferred()
    h.api.link(sock)
    await h.api.request(sock, 'debugger.attach', { tabId: 1 })
    h.chrome.debugger.sendCommand.mockImplementationOnce(() => command.promise as never)
    const pending = h.api.request(sock, 'cdp.send', { tabId: 1, method: 'Page.navigate' })
    await vi.waitFor(() => expect(h.chrome.debugger.sendCommand).toHaveBeenCalledTimes(1))
    h.api.close(sock)
    await vi.waitFor(() => expect(h.chrome.debugger.detach).toHaveBeenCalledTimes(1))
    command.resolve()
    await pending
  })

  it('does not revive an old pending attach after revoke and handover', async () => {
    const h = harness(),
      sock = h.socket(),
      gate = deferred()
    h.api.link(sock)
    h.chrome.debugger.attach.mockImplementationOnce(() => gate.promise as never)
    const pending = h.api.request(sock, 'debugger.attach', { tabId: 1 })
    await vi.waitFor(() => expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1))
    await new Promise<void>((resolve) => h.listeners.popup({ t: 'revoke', tabId: 1 }, {}, resolve))
    await new Promise<void>((resolve) => h.listeners.popup({ t: 'handover', tabId: 1 }, {}, resolve))
    gate.resolve()
    await pending
    expect(h.chrome.debugger.detach).toHaveBeenCalledTimes(1)
    const responses = sock.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter((msg) => msg.t === 'res')
    expect(responses[0].ok).toBe(false)
    await h.api.request(sock, 'debugger.attach', { tabId: 1 })
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(2)
  })
  it('treats cancellation of the Chrome debugger banner as persistent revocation', async () => {
    const h = harness([1]),
      sock = h.socket()
    h.api.link(sock)
    await h.api.request(sock, 'debugger.attach', { tabId: 1 })
    h.listeners.detach({ tabId: 1 }, 'canceled_by_user')
    await h.api.request(sock, 'debugger.attach', { tabId: 1 })
    expect(h.chrome.debugger.attach).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => {
      expect(await h.chrome.storage.session.get()).toEqual({ handed: [], owned: [] })
    })
    await h.api.request(sock, 'tabs.list')
    const last = JSON.parse(sock.send.mock.calls.at(-1)![0])
    expect(last.result[0].handed).toBe(false)
  })

  it('does not let a delayed popup handover undo a newer revoke', async () => {
    const h = harness(),
      sock = h.socket(),
      gate = deferred()
    h.api.link(sock)
    h.chrome.tabs.get.mockImplementationOnce(() => gate.promise as never)
    const old = new Promise((resolve) => h.listeners.popup({ t: 'handover', tabId: 1 }, {}, resolve))
    await new Promise((resolve) => h.listeners.popup({ t: 'revoke', tabId: 1 }, {}, resolve))
    gate.resolve({ id: 1 })
    expect(await old).toMatchObject({ ok: false })
    await h.api.request(sock, 'debugger.attach', { tabId: 1 })
    expect(h.chrome.debugger.attach).not.toHaveBeenCalled()
    expect((await h.chrome.storage.session.get()).handed).toEqual([])
    expect(sock.send.mock.calls.map(([raw]) => JSON.parse(raw)).some((msg) => msg.name === 'handover')).toBe(false)
  })

  it('preserves both tabs when popup handovers run concurrently', async () => {
    const h = harness()
    await Promise.all([2, 3].map((tabId) => new Promise((resolve) => h.listeners.popup({ t: 'handover', tabId }, {}, resolve))))
    expect((await h.chrome.storage.session.get()).handed).toEqual([1, 2, 3])
  })
  it('does not restore persistent ownership when create finishes after revocation', async () => {
    const h = harness(),
      sock = h.socket(),
      gate = deferred()
    h.api.link(sock)
    h.chrome.tabs.create.mockImplementationOnce(() => gate.promise as never)
    const pending = h.api.request(sock, 'tabs.create')
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => h.listeners.popup({ t: 'revoke', tabId: 2 }, {}, resolve))
    gate.resolve({ id: 2 })
    await pending
    expect((await h.chrome.storage.session.get()).owned).not.toContain(2)
  })

  it('rechecks ownership authorization after a pending storage read', async () => {
    const h = harness(),
      sock = h.socket(),
      gate = deferred()
    h.api.link(sock)
    h.chrome.storage.session.get.mockImplementationOnce(() => gate.promise as never)
    const pending = h.api.request(sock, 'tabs.create')
    await vi.waitFor(() => expect(h.chrome.storage.session.get).toHaveBeenCalledTimes(1))
    const revoked = new Promise((resolve) => h.listeners.popup({ t: 'revoke', tabId: 2 }, {}, resolve))
    gate.resolve({ handed: [1], owned: [] })
    await Promise.all([pending, revoked])
    const response = sock.send.mock.calls.map(([raw]) => JSON.parse(raw)).find((msg) => msg.t === 'res')
    expect(response.ok).toBe(false)
    expect((await h.chrome.storage.session.get()).owned).not.toContain(2)
  })
})
