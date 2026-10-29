import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
import { DesktopClient, DesktopTransportError } from '../src/main/desktop/client'

function setup(timeout = 100) {
  const children: ReturnType<typeof child>[] = []
  function child() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    })
  }
  mocks.spawn.mockImplementation(() => {
    const c = child()
    children.push(c)
    return c
  })
  const onFailure = vi.fn()
  const onInput = vi.fn()
  const client = new DesktopClient({ executable: '/fake/helper', timeout, onFailure, onInput })
  const requests = (index = 0) =>
    children[index].stdin
      .read()
      ?.toString()
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line)) ?? []
  const reply = (value: unknown, index = 0) => children[index].stdout.write(`${JSON.stringify(value)}\n`)
  return { client, children, requests, reply, onFailure, onInput }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('desktop client transport', () => {
  it('correlates out-of-order replies and separates native action errors from transport errors', async () => {
    const f = setup()
    const first = f.client.request('apps')
    const second = f.client.request('click', { ref: 'native-1' })
    const failed = expect(second).rejects.toThrow('element disappeared')
    const [a, b] = f.requests()
    f.reply({ id: b.id, ok: false, error: 'element disappeared' })
    f.reply({ id: a.id, ok: true, result: ['Notes'] })
    expect(await first).toEqual(['Notes'])
    await failed
    expect(f.onFailure).not.toHaveBeenCalled()
    f.client.close()
  })

  it('times out all pending requests, kills the helper, and never replays input', async () => {
    vi.useFakeTimers()
    const f = setup()
    const first = f.client.request('click', { x: 10, y: 20 })
    const second = f.client.request('apps')
    const failures = [expect(first).rejects.toBeInstanceOf(DesktopTransportError), expect(second).rejects.toThrow('超时')]
    const old = f.requests()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all(failures)
    expect(f.children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.onFailure).toHaveBeenCalledTimes(1)
    const fresh = f.client.request('ax_tree')
    const [request] = f.requests(1)
    expect(request.cmd).toBe('ax_tree')
    expect(request.id).toBeGreaterThan(old[1].id)
    f.reply({ id: old[0].id, ok: true, result: 'late' })
    f.reply({ id: request.id, ok: true, result: 'fresh' }, 1)
    expect(await fresh).toBe('fresh')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.children[0].kill).toHaveBeenCalledWith('SIGKILL')
    f.client.close()
  })

  it('rejects all pending work on crash and ignores the old process after restart', async () => {
    const f = setup()
    const first = f.client.request('type', { text: 'abc' })
    const second = f.client.request('apps')
    const failures = [expect(first).rejects.toThrow('退出'), expect(second).rejects.toThrow('退出')]
    f.requests()
    f.children[0].emit('exit', 1)
    await Promise.all(failures)
    const fresh = f.client.request('apps')
    const [request] = f.requests(1)
    f.children[0].emit('exit', 1)
    f.reply({ id: request.id, ok: true, result: ['Notes'] }, 1)
    expect(await fresh).toEqual(['Notes'])
    expect(f.onFailure).toHaveBeenCalledTimes(1)
    f.client.close()
  })

  it('cleans pending requests on close and forwards user input notifications', async () => {
    const f = setup()
    const pending = f.client.request('click')
    const failure = expect(pending).rejects.toThrow('停止')
    f.reply({ event: 'user_input', reason: 'mouse' })
    expect(f.onInput).toHaveBeenCalledWith('mouse')
    f.client.close()
    await failure
    expect(f.onFailure).not.toHaveBeenCalled()
    f.client.close()
    expect(f.children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('fails malformed replies and spawn errors without retrying requests', async () => {
    const f = setup()
    const first = f.client.request('click')
    const failed = expect(first).rejects.toThrow('无效响应')
    f.children[0].stdout.write('not json\n')
    await failed
    const second = f.client.request('apps')
    const failedAgain = expect(second).rejects.toThrow('无法启动')
    f.children[1].emit('error', new Error('missing helper'))
    await failedAgain
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(f.onFailure).toHaveBeenCalledTimes(2)
  })

  it('rejects unserializable arguments before allocating a pending request or spawning', async () => {
    vi.useFakeTimers()
    const f = setup()
    const args: Record<string, unknown> = {}
    args.self = args
    expect(() => f.client.request('type', args)).toThrow()
    expect(mocks.spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.onFailure).not.toHaveBeenCalled()
    const pending = f.client.request('apps')
    const [request] = f.requests()
    expect(request.cmd).toBe('apps')
    f.reply({ id: request.id, ok: true, result: [] })
    expect(await pending).toEqual([])
    f.client.close()
  })
})
