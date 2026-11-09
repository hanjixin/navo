import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcMessage, RunRequest } from '../src/main/agent-host/protocol'
import type { RuntimeCallbacks } from '../src/main/agent-runtime/types'

const mock = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }))
vi.mock('../src/main/core/app-dir', () => ({ appFile: (path: string) => path }))
vi.mock('../src/main/core/paths', () => ({ paths: { db: '/tmp/db', checkpoints: '/tmp/checkpoints' } }))
vi.mock('../src/main/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }))
import { BuiltinRuntimeAdapter } from '../src/main/agent-runtime/builtin'

class Child extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  postMessage = vi.fn()
  kill = vi.fn()
  answer(index: number, result: unknown): void {
    const request = this.postMessage.mock.calls[index][0] as { id: number }
    this.emit('message', { kind: 'res', id: request.id, ok: true, result } satisfies RpcMessage)
  }
}
let children: Child[]
let callbacks: RuntimeCallbacks
beforeEach(() => {
  children = []
  mock.fork.mockImplementation(() => {
    const child = new Child()
    children.push(child)
    return child
  })
  callbacks = { event: vi.fn(), callTool: vi.fn(async () => 'ok'), workspaceWrite: vi.fn(), usage: vi.fn() }
})
describe('built-in runtime lifecycle', () => {
  it('deletes checkpoints after an aborted run has finished writing', async () => {
    const adapter = new BuiltinRuntimeAdapter(callbacks)
    const running = adapter.run({ threadId: 'thread' } as RunRequest)
    const deleting = adapter.deleteThread('thread')
    const child = children[0]
    expect(child.postMessage.mock.calls.map(([message]) => message.method)).toEqual(['run.start', 'run.abort'])
    child.answer(1, undefined)
    await Promise.resolve()
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    child.answer(0, { finalText: '', interrupted: false, aborted: true })
    await running
    await Promise.resolve()
    expect(child.postMessage.mock.calls[2][0].method).toBe('thread.delete')
    child.answer(2, undefined)
    await deleting
    adapter.shutdown()
  })
  it('cleans checkpoints after worker failure rejects both abort and run', async () => {
    const adapter = new BuiltinRuntimeAdapter(callbacks)
    const running = adapter.run({ threadId: 'thread' } as RunRequest)
    const rejected = expect(running).rejects.toThrow('退出')
    const deleting = adapter.deleteThread('thread')
    children[0].emit('exit', 1)
    await rejected
    await Promise.resolve()
    expect(children).toHaveLength(2)
    expect(children[1].postMessage.mock.calls[0][0].method).toBe('thread.delete')
    children[1].answer(0, undefined)
    await deleting
    adapter.shutdown()
  })
  it('bounds UI waiting for a stuck run and cleans its checkpoints when it eventually exits', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new BuiltinRuntimeAdapter(callbacks)
      const running = adapter.run({ threadId: 'thread' } as RunRequest)
      const deleting = adapter.deleteThread('thread')
      children[0].answer(1, undefined)
      await vi.advanceTimersByTimeAsync(5000)
      await deleting
      expect(children[0].postMessage).toHaveBeenCalledTimes(2)
      children[0].answer(0, { finalText: '', interrupted: false, aborted: true })
      await running
      await Promise.resolve()
      expect(children[0].postMessage.mock.calls[2][0].method).toBe('thread.delete')
      children[0].answer(2, undefined)
      await Promise.resolve()
      adapter.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
  it('lazily starts and preserves checkpoint RPC operations', async () => {
    const adapter = new BuiltinRuntimeAdapter(callbacks)
    await adapter.abort('thread')
    expect(children).toHaveLength(0)
    const pending = adapter.state('thread')
    expect(children[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'thread.state', params: { threadId: 'thread' } }))
    const state = { messages: [], todos: [], interrupt: null }
    children[0].answer(0, state)
    expect(await pending).toEqual(state)
    adapter.shutdown()
    expect(children[0].kill).toHaveBeenCalledOnce()
  })
  it('rejects in-flight operations and ignores events and tool calls from replaced workers', async () => {
    const adapter = new BuiltinRuntimeAdapter(callbacks)
    const pending = adapter.state('thread')
    const rejected = expect(pending).rejects.toThrow('stopped')
    const old = children[0]
    adapter.refresh()
    await rejected
    const next = adapter.state('thread')
    old.emit('message', { kind: 'evt', name: 'chat.event', payload: { type: 'error', threadId: 'thread', error: 'late' } })
    old.emit('message', { kind: 'req', id: 100, method: 'tool.call', params: { threadId: 'thread' } })
    expect(callbacks.event).not.toHaveBeenCalled()
    expect(callbacks.callTool).not.toHaveBeenCalled()
    children[1].answer(0, { messages: [], todos: [], interrupt: null })
    await next
    old.emit('exit', 0)
    const still = adapter.pendingApprovals()
    children[1].answer(1, [])
    expect(await still).toEqual([])
    expect(children).toHaveLength(2)
    adapter.shutdown()
  })
})
