import { describe, expect, it, vi } from 'vitest'
import { DesktopController } from '../src/main/desktop/controller'
import { DesktopConsent } from '../src/main/desktop/consent'
import { DesktopTransportError, type DesktopTransport } from '../src/main/desktop/client'
import type { DesktopConsentRequest } from '../src/shared/types'

const window = { id: 'window-1', pid: 123, bounds: { x: -100, y: 20, width: 100, height: 50 } }
const app = { name: 'Notes', bundleId: 'com.apple.Notes', pid: 123, window }
const tree = { app, window, nodes: [{ id: 'native-1', role: 'AXButton', title: 'Save', enabled: true, depth: 0 }] }
const image = { data: '', width: 200, height: 100, bounds: { x: -100, y: 20, width: 100, height: 50 }, window }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function setup() {
  const calls: { cmd: string; args: Record<string, unknown> }[] = []
  const state = {
    enabled: true,
    supported: true,
    available: true,
    accessibility: true,
    screenRecording: true,
    blocked: [] as string[],
    at: app as typeof app | null,
  }
  let override: ((cmd: string, args: Record<string, unknown>) => Promise<unknown> | undefined) | undefined
  const client: DesktopTransport = {
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ cmd, args })
      const result = override?.(cmd, args)
      if (result) return (await result) as T
      return (
        {
          permissions: { accessibility: state.accessibility, screenRecording: state.screenRecording },
          apps: [app],
          resolve: app,
          frontmost: app,
          activate: app,
          ax_tree: tree,
          screenshot: image,
          window_at: state.at,
        } as Record<string, unknown>
      )[cmd] as T
    },
    close: vi.fn(),
  }
  let prompt: DesktopConsentRequest | null = null
  const consent = new DesktopConsent({
    blocked: () => state.blocked,
    revoked: (threadId) => controller.stop(threadId, true, 'authorization_revoked'),
    publish: (value) => {
      prompt = value
    },
  })
  const abort = vi.fn()
  const controller = new DesktopController({
    client,
    consent,
    enabled: () => state.enabled,
    supported: () => state.supported,
    available: () => state.available,
    blocked: () => state.blocked,
    changed: vi.fn(),
    abort,
  })
  const approve = async (decision: 'once' | 'session' | 'execution' = 'session') => {
    await settle()
    expect(prompt).not.toBeNull()
    consent.resolve(prompt!.id, decision)
    await settle()
  }
  const snapshot = async () => {
    const p = controller.snapshot('one', app.name)
    await approve()
    return p
  }
  return {
    state,
    calls,
    client,
    abort,
    controller,
    consent,
    approve,
    snapshot,
    prompt: () => prompt,
    intercept: (fn: typeof override) => {
      override = fn
    },
  }
}

describe('desktop controller', () => {
  it('rejects disabled, unsupported and unavailable environments before native access', async () => {
    for (const key of ['enabled', 'supported', 'available'] as const) {
      const f = setup()
      f.state[key] = false
      await expect(f.controller.apps('one')).rejects.toThrow()
      expect(f.calls).toHaveLength(0)
    }
  })

  it('lists apps without AX permission but gates reading and screen capture', async () => {
    const f = setup()
    f.state.accessibility = false
    expect(await f.controller.apps('one')).toContain(app.name)
    await expect(f.controller.snapshot('one')).rejects.toThrow('辅助功能')
    f.state.accessibility = true
    f.state.screenRecording = false
    expect(f.controller.status().lastStop?.reason).toBe('permission_missing')
    f.controller.beginRun('one')
    await expect(f.controller.screenshot('one')).rejects.toThrow('屏幕录制')
    expect(f.prompt()).toBeNull()
    expect(f.calls.some((c) => c.cmd === 'ax_tree')).toBe(false)
  })

  it('requires consent for reading and mutation and does not persist once approval', async () => {
    const f = setup()
    const first = f.controller.snapshot('one', app.name)
    await settle()
    expect(f.calls.some((c) => c.cmd === 'activate')).toBe(false)
    await f.approve('once')
    await first
    const mutation = f.controller.action('one', 'type', { text: 'hi' })
    const denied = expect(mutation).rejects.toThrow('拒绝')
    await settle()
    expect(f.prompt()).not.toBeNull()
    expect(f.calls.some((c) => c.cmd === 'type')).toBe(false)
    f.consent.resolve(f.prompt()!.id, 'deny')
    await denied
  })

  it('rechecks blocks after session approval and rejects another desktop owner', async () => {
    const f = setup()
    await f.snapshot()
    await expect(f.controller.apps('two')).rejects.toThrow('另一个')
    f.state.blocked.push(app.bundleId)
    await expect(f.controller.action('one', 'key', { key: 'ENTER' })).rejects.toThrow('禁止')
    expect(f.calls.some((c) => c.cmd === 'key')).toBe(false)
    await f.controller.endRun('one')
    expect(await f.controller.apps('two')).toBe('[]')
  })

  it('stops while consent is pending without activating or injecting', async () => {
    const f = setup()
    const p = f.controller.snapshot('one', app.name)
    const rejected = expect(p).rejects.toThrow('取消')
    await settle()
    f.controller.stop('one')
    await rejected
    expect(f.calls.some((c) => ['activate', 'type', 'click'].includes(c.cmd))).toBe(false)
  })

  it('stops while activation is pending and never sends the requested injection', async () => {
    const f = setup()
    await f.snapshot()
    const gate = deferred<typeof app>()
    f.intercept((cmd) => (cmd === 'activate' ? gate.promise : undefined))
    const p = f.controller.action('one', 'type', { text: 'secret' })
    const rejected = expect(p).rejects.toThrow('中止')
    await settle()
    f.controller.stop('one')
    gate.resolve(app)
    await rejected
    expect(f.calls.some((c) => c.cmd === 'type')).toBe(false)
  })

  it('does not capture or inject again after stop during a pending injection', async () => {
    const f = setup()
    await f.snapshot()
    const gate = deferred<unknown>()
    f.intercept((cmd) => (cmd === 'type' ? gate.promise : undefined))
    const count = f.calls.filter((c) => c.cmd === 'ax_tree').length
    const p = f.controller.action('one', 'type', { text: 'a' })
    const rejected = expect(p).rejects.toThrow('中止')
    await settle()
    expect(f.calls.filter((c) => c.cmd === 'type')).toHaveLength(1)
    f.controller.stop('one')
    gate.resolve(null)
    await rejected
    expect(f.calls.filter((c) => c.cmd === 'ax_tree')).toHaveLength(count)
    await expect(f.controller.action('one', 'type', { text: 'b' })).rejects.toThrow('中止')
  })

  it('expires references after recapture and after a helper failure', async () => {
    const f = setup()
    const first = await f.snapshot()
    const ref = first.match(/\[(d\d+)\]/)![1]
    const second = await f.controller.snapshot('one')
    await expect(f.controller.action('one', 'click', { ref })).rejects.toThrow('失效')
    f.controller.failed()
    await expect(f.controller.action('one', 'click', { ref: second.match(/\[(d\d+)\]/)![1] })).rejects.toThrow('服务故障')
    expect(f.controller.status().lastStop?.reason).toBe('service_failure')
    expect(f.calls.some((c) => c.cmd === 'click')).toBe(false)
  })

  it('requires a screenshot and verifies global coordinate ownership before injection', async () => {
    const f = setup()
    await f.snapshot()
    await expect(f.controller.action('one', 'click', { x: 10, y: 20 })).rejects.toThrow('截图')
    await f.controller.screenshot('one')
    f.state.at = { ...app, bundleId: 'other.app' }
    await expect(f.controller.action('one', 'click', { x: 100, y: 50 })).rejects.toThrow('不属于')
    expect(f.calls.find((c) => c.cmd === 'window_at')?.args).toEqual({ x: -50, y: 45 })
    expect(f.calls.some((c) => c.cmd === 'click')).toBe(false)
    f.state.at = app
    await expect(f.controller.action('one', 'click', { x: 100, y: 50 })).rejects.toThrow('截图')
    await f.controller.screenshot('one')
    await f.controller.action('one', 'click', { x: 100, y: 50 })
    expect(f.calls.find((c) => c.cmd === 'click')?.args).toMatchObject({ x: -50, y: 45, bundleId: app.bundleId })
    await expect(f.controller.action('one', 'click', { x: 100, y: 50 })).rejects.toThrow('截图')
  })

  it('pauses after three transport failures without retrying an uncertain mutation', async () => {
    const f = setup()
    await f.snapshot()
    f.intercept((cmd) => (cmd === 'type' || cmd === 'ax_tree' ? Promise.reject(new DesktopTransportError('crashed')) : undefined))
    await expect(f.controller.action('one', 'type', { text: 'a' })).rejects.toThrow('结果未知')
    await expect(f.controller.action('one', 'type', { text: 'a' })).rejects.toThrow('结果未知')
    await expect(f.controller.snapshot('one')).rejects.toThrow('crashed')
    await expect(f.controller.snapshot('one')).rejects.toThrow('服务连续失败')
    await expect(f.controller.action('one', 'type', { text: 'a' })).rejects.toThrow('服务故障')
    expect(f.calls.filter((c) => c.cmd === 'type')).toHaveLength(1)
    await settle()
    expect(f.calls.filter((c) => c.cmd === 'release')).toHaveLength(1)
    expect(f.abort).not.toHaveBeenCalled()
    expect(await f.controller.apps('two')).toContain(app.name)
  })

  it('shares release between stop and endRun and retains ownership for the next thread', async () => {
    const f = setup()
    await f.snapshot()
    const release = deferred<unknown>()
    f.intercept((cmd) => (cmd === 'release' ? release.promise : undefined))
    f.controller.stop('one')
    const ended = f.controller.endRun('one')
    expect(f.calls.filter((c) => c.cmd === 'release')).toHaveLength(1)
    await expect(f.controller.apps('two')).rejects.toThrow('另一个')
    release.resolve(null)
    await ended
    const next = f.controller.snapshot('two', app.name)
    await f.approve()
    await next
    await settle()
    await expect(f.controller.apps('three')).rejects.toThrow('另一个')
    expect(f.controller.status().active?.threadId).toBe('two')
    expect(f.calls.filter((c) => c.cmd === 'release')).toHaveLength(1)
  })

  it('does not abort browser-only runs when shutting down desktop support', async () => {
    const f = setup()
    f.controller.beginRun('browser-only')
    f.controller.shutdown()
    expect(f.abort).not.toHaveBeenCalled()
    expect(f.client.close).toHaveBeenCalledOnce()
    const active = setup()
    active.controller.beginRun('browser-only')
    await active.snapshot()
    active.controller.shutdown()
    expect(active.abort).toHaveBeenCalledExactlyOnceWith('one')
  })

  it('preserves a newer run created while the old run is releasing', async () => {
    const f = setup()
    await f.snapshot()
    const release = deferred<unknown>()
    f.intercept((cmd) => (cmd === 'release' ? release.promise : undefined))
    const ended = f.controller.endRun('one')
    f.controller.beginRun('one')
    // A stopped new run must remain stopped; deleting it would silently create an unstopped run.
    f.controller.stop('one', false)
    release.resolve(null)
    await ended
    await expect(f.controller.apps('one')).rejects.toThrow('中止')
  })

  it('rejects coordinates invalidated by helper failure while approval is pending', async () => {
    const f = setup()
    const screenshot = f.controller.screenshot('one', app.name)
    await f.approve('once')
    await screenshot
    const action = f.controller.action('one', 'click', { x: 100, y: 50 })
    const rejected = expect(action).rejects.toThrow(/取消/)
    await settle()
    expect(f.prompt()).not.toBeNull()
    const stale = f.prompt()!.id
    f.controller.failed()
    expect(f.prompt()).toBeNull()
    expect(() => f.consent.resolve(stale, 'once')).toThrow('失效')
    await rejected
    expect(f.calls.some((c) => c.cmd === 'click')).toBe(false)
  })

  it('suspends user-input monitoring before approval and rearms it before activation', async () => {
    const f = setup()
    const first = f.controller.snapshot('one', app.name)
    await f.approve('once')
    await first
    const offset = f.calls.length
    const disabled = deferred<unknown>()
    f.intercept((cmd, args) => (cmd === 'watch_user_input' && args.enabled === false ? disabled.promise : undefined))
    const next = f.controller.snapshot('one')
    await settle()
    expect(f.calls.slice(offset).at(-1)).toEqual({ cmd: 'watch_user_input', args: { enabled: false } })
    expect(f.prompt()).toBeNull()
    disabled.resolve(null)
    await settle()
    expect(f.prompt()).not.toBeNull()
    expect(f.calls.slice(offset).some((c) => c.cmd === 'activate')).toBe(false)
    await f.approve('once')
    await next
    const commands = f.calls.slice(offset)
    const rearmed = commands.findIndex((c) => c.cmd === 'watch_user_input' && c.args.enabled === true)
    expect(rearmed).toBeGreaterThan(-1)
    expect(commands.findIndex((c) => c.cmd === 'activate')).toBeGreaterThan(rearmed)
  })

  it('rejects a different window, process or geometry even when the app identity matches', async () => {
    for (const changed of [
      { ...window, id: 'window-2' },
      { ...window, pid: 456 },
      { ...window, bounds: { ...window.bounds, x: 12 } },
      { ...window, bounds: { ...window.bounds, width: 101 } },
    ]) {
      const f = setup()
      await f.snapshot()
      await f.controller.screenshot('one')
      f.state.at = { ...app, window: changed }
      await expect(f.controller.action('one', 'click', { x: 100, y: 50 })).rejects.toThrow('窗口')
      f.state.at = app
      await expect(f.controller.action('one', 'click', { x: 100, y: 50 })).rejects.toThrow('截图')
      expect(f.calls.some((call) => call.cmd === 'click')).toBe(false)
    }
  })

  it('passes the observed window identity for ref, keyboard and coordinate input', async () => {
    const f = setup()
    const snapshot = await f.snapshot()
    await f.controller.action('one', 'type', { ref: snapshot.match(/\[(d\d+)\]/)![1], text: 'hello' })
    await f.controller.action('one', 'key', { combo: 'tab' })
    await f.controller.screenshot('one')
    await f.controller.action('one', 'click', { x: 10, y: 20 })
    for (const cmd of ['type', 'key', 'click']) expect(f.calls.find((call) => call.cmd === cmd)?.args.expectedWindow).toEqual(window)
  })

  it('keeps reads available but refuses input without a verifiable window', async () => {
    const f = setup()
    f.intercept((cmd) => (cmd === 'ax_tree' ? Promise.resolve({ ...tree, window: undefined }) : undefined))
    const snapshot = await f.snapshot()
    expect(snapshot).toContain('Save')
    await expect(f.controller.action('one', 'click', { ref: snapshot.match(/\[(d\d+)\]/)![1] })).rejects.toThrow('目标窗口')
    await expect(f.controller.action('one', 'key', { combo: 'enter' })).rejects.toThrow('目标窗口')
    expect(f.calls.some((call) => ['click', 'key'].includes(call.cmd))).toBe(false)
  })

  it('discards handles after native refusal instead of replaying old input', async () => {
    const f = setup()
    const snapshot = await f.snapshot()
    const ref = snapshot.match(/\[(d\d+)\]/)![1]
    f.intercept((cmd) => (cmd === 'click' ? Promise.reject(new Error('目标窗口已变化')) : undefined))
    await expect(f.controller.action('one', 'click', { ref })).rejects.toThrow('窗口')
    await expect(f.controller.action('one', 'click', { ref })).rejects.toThrow('失效')
    await expect(f.controller.action('one', 'key', { combo: 'enter' })).rejects.toThrow('快照')
    expect(f.calls.filter((call) => call.cmd === 'click')).toHaveLength(1)
  })

  it('matches unescaped and budget-omitted text while waiting', async () => {
    const f = setup()
    await f.snapshot()
    const raw = 'He said "ready"\nnext line'
    f.intercept((cmd) => (cmd === 'ax_tree' ? Promise.resolve({ ...tree, nodes: [{ ...tree.nodes[0], title: raw }] }) : undefined))
    await expect(f.controller.waitFor('one', raw, 0)).resolves.toBeTypeOf('string')
    const nodes = [
      ...Array.from({ length: 200 }, (_, index) => ({ ...tree.nodes[0], id: `control-${index}`, title: 'button'.repeat(40) })),
      { ...tree.nodes[0], role: 'AXStaticText', id: 'target', title: raw, value: 'Windows\r\ntext' + '.'.repeat(700) },
    ]
    f.intercept((cmd) => (cmd === 'ax_tree' ? Promise.resolve({ ...tree, nodes }) : undefined))
    const result = await f.controller.waitFor('one', raw, 0)
    expect(result).not.toContain('ready')
    await expect(f.controller.waitFor('one', 'Windows\ntext', 0)).resolves.toBeTypeOf('string')
    await expect(f.controller.waitFor('one', 'missing', 0)).rejects.toThrow('等待超时')
  })
})

describe('desktop authorization lifecycle and state', () => {
  it('keeps execution grants across tool approval resumes, then clears them on completion', async () => {
    const f = setup()
    f.controller.beginRun('one', 'task')
    const first = f.controller.snapshot('one', app.name)
    await f.approve('execution')
    await first
    await f.controller.endRun('one')
    expect(f.consent.grants()).toHaveLength(1)
    f.controller.beginRun('one', 'task')
    expect(await f.controller.snapshot('one', app.name)).toContain('Save')
    expect(f.prompt()).toBeNull()
    await f.controller.endRun('one')
    f.controller.endExecution('one', 'task')
    expect(f.consent.grants()).toEqual([])
  })
  it('revocation stops further actions and reports the authorization reason', async () => {
    const f = setup()
    await f.snapshot()
    f.consent.revoke(f.consent.grants()[0].id)
    expect(f.abort).toHaveBeenCalledWith('one')
    expect(f.controller.status().lastStop).toMatchObject({ reason: 'authorization_revoked', threadId: 'one' })
    await expect(f.controller.action('one', 'type', { text: 'not sent' })).rejects.toThrow('撤销')
    expect(f.calls.some((call) => call.cmd === 'type')).toBe(false)
  })
  it('preserves takeover reason when the agent stops the same run afterward', async () => {
    const f = setup()
    await f.snapshot()
    f.controller.stop('one', true, 'user_takeover')
    f.controller.stop('one', false)
    expect(f.controller.status().lastStop?.reason).toBe('user_takeover')
  })
  it('reports untested/checking states and merges concurrent refreshes', async () => {
    const f = setup(),
      gate = deferred<unknown>()
    expect(f.controller.status()).toMatchObject({ checkedAt: null, checking: false })
    f.intercept((cmd) => (cmd === 'permissions' ? gate.promise : undefined))
    const first = f.controller.refresh(),
      second = f.controller.refresh()
    expect(f.controller.status()).toMatchObject({ checkedAt: null, checking: true })
    expect(f.calls.filter((call) => call.cmd === 'permissions')).toHaveLength(1)
    gate.resolve({ accessibility: true, screenRecording: true })
    await Promise.all([first, second])
    expect(f.controller.status()).toMatchObject({ checkedAt: expect.any(Number), checking: false, helper: 'ok' })
  })
})
