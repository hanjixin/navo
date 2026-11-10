import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunRequest, RunResult } from '../src/main/agent-runtime/contracts'
import type { ExternalRuntimeDriver, RuntimeCallbacks, RuntimeToolResult } from '../src/main/agent-runtime/types'
import type { RuntimeStateStore } from '../src/main/agent-runtime/state-store'
import type { Decision, UIMessage } from '../src/shared/types'
import { ExternalRuntimeAdapter, type ExternalSavedSession } from '../src/main/agent-runtime/external'

vi.mock('../src/main/core/db', () => ({
  db: () => {
    throw new Error('Test must use injected state store')
  },
}))
vi.mock('../src/main/core/paths', () => ({ paths: { userData: '/tmp/navo-tool-contracts' } }))

class MemoryStore implements RuntimeStateStore<ExternalSavedSession> {
  value: ExternalSavedSession | null = null
  read(): ExternalSavedSession | null {
    return structuredClone(this.value)
  }
  write(_id: string, value: ExternalSavedSession): void {
    this.value = structuredClone(value)
  }
  remove(): void {
    this.value = null
  }
}
const adapters: ExternalRuntimeAdapter[] = []
const drain = () => new Promise<void>((resolve) => setImmediate(resolve))
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.shutdown()
  await drain()
})
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: 'run-1',
    executionId: 'execution',
    threadId: 'thread',
    input: { kind: 'message', id: 'user-1', text: 'Do the task', images: [] },
    model: { providerType: 'openai-compatible', model: 'external', supportsVision: false },
    systemPrompt: '',
    tools: ['write_file', 'memory_search'].map((name) => ({ name, description: name, source: 'navo', schema: { type: 'object' } })),
    interruptOn: ['write_file'],
    browserSubagent: false,
    mounts: [],
    paths: { workspace: '/tmp', uploads: '/tmp', skills: '/tmp' },
    devMode: false,
    meta: { threadTitle: 'Test', modelLabel: 'External', appVersion: 'test' },
    ...overrides,
  }
}
const resume = (runId = 'run-2', decision: Decision = { type: 'approve' }, overrides: Partial<RunRequest> = {}) =>
  request({ runId, input: { kind: 'resume', decisions: [decision] }, ...overrides })
const write = (id = 'call-1') => ({ id, name: 'write_file', args: { file_path: '/workspace/test.txt', content: 'hello' } })
function setup(behavior: ExternalRuntimeDriver['run'], store = new MemoryStore()) {
  const callbacks: RuntimeCallbacks = {
    event: vi.fn(),
    callTool: vi.fn(async () => 'Tool result'),
    workspaceWrite: vi.fn(),
    usage: vi.fn(),
    unavailable: vi.fn(),
  }
  const driver: ExternalRuntimeDriver = {
    kind: 'claude',
    capabilities: {
      navoTools: true,
      nativeTools: false,
      approvals: true,
      images: false,
      resume: true,
      fork: false,
      tokenStreaming: true,
      requiresNavoModel: false,
      workspaceTools: true,
    },
    run: vi.fn(async (context) =>
      Promise.race([
        behavior(context),
        new Promise<RunResult>((resolve) =>
          context.signal.addEventListener('abort', () => resolve({ finalText: '', interrupted: false, aborted: true }), { once: true }),
        ),
      ]),
    ),
  }
  const adapter = new ExternalRuntimeAdapter(
    'thread',
    { id: 'claude', kind: 'claude', name: 'Claude', enabled: true, command: 'unused', args: [] },
    driver,
    callbacks,
    undefined,
    store,
  )
  adapters.push(adapter)
  return { adapter, callbacks, driver, store }
}
const done = { finalText: 'Done', interrupted: false }

describe('external runtime tool approval lifecycle', () => {
  it('ignores unknown and completed tool cancellations while the engine remains active', async () => {
    const finished = pending<void>()
    const hold = pending<void>()
    const { adapter } = setup(async (context) => {
      context.tools!.cancel?.('unknown')
      expect(context.signal.aborted).toBe(false)
      await context.tools!.call({ id: 'read', name: 'memory_search', args: {} })
      context.tools!.cancel?.('read')
      expect(context.signal.aborted).toBe(false)
      finished.resolve()
      await hold.promise
      return done
    })
    const running = adapter.run(request())
    await finished.promise
    hold.resolve()
    expect(await running).toMatchObject({ finalText: 'Done', interrupted: false })
  })
  it('ignores an old execution cancel even when the new execution reuses its tool ID', async () => {
    let oldCancel: ((id: string) => void) | undefined
    const { adapter } = setup(async (context) => {
      if (!oldCancel) {
        oldCancel = context.tools!.cancel
        return done
      }
      const tool = context.tools!.call(write('shared-id'))
      oldCancel('shared-id')
      expect(context.signal.aborted).toBe(false)
      await tool
      return done
    })
    await adapter.run(request())
    expect(await adapter.run(request({ runId: 'new-run' }))).toMatchObject({ interrupted: true })
    expect(await adapter.run(resume('approved-run'))).toMatchObject({ finalText: 'Done' })
  })
  it('allows cancellation of a currently pending tool approval', async () => {
    let cancel: ((id: string) => void) | undefined
    const { adapter } = setup(async (context) => {
      cancel = context.tools!.cancel
      await context.tools!.call(write('pending'))
      return done
    })
    expect(await adapter.run(request())).toMatchObject({ interrupted: true })
    cancel?.('pending')
    await drain()
    await expect(adapter.run(resume())).rejects.toThrow()
  })
  it('finalizes observed native tools when cancellation suppresses their late protocol events', async () => {
    const { adapter, callbacks } = setup(async (context) => {
      context.emit({
        type: 'message',
        threadId: 'thread',
        message: {
          id: 'native-call',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'native', name: 'codex_run_command', args: { command: 'pwd' }, activity: { kind: 'command', command: 'pwd', status: 'running' } }],
        },
      })
      return new Promise(() => {})
    })
    const running = adapter.run(request())
    await drain()
    adapter.abort('thread')
    expect((await running).aborted).toBe(true)
    const state = await adapter.state('thread')
    expect(state.messages.find((message) => message.id === 'native-call')?.toolCalls?.[0].activity?.status).toBe('cancelled')
    expect(state.messages.some((message) => message.toolCallId === 'native' && message.runtimeWarning === 'tool_outcome_unknown')).toBe(true)
    expect(callbacks.callTool).not.toHaveBeenCalled()
  })
  it('pauses without executing and resumes one driver using a new run ID and the same execution', async () => {
    const { adapter, callbacks, driver, store } = setup(async (context) => {
      await context.tools!.call(write())
      return done
    })
    expect(await adapter.run(request())).toMatchObject({ interrupted: true })
    expect(callbacks.callTool).not.toHaveBeenCalled()
    expect(store.value?.pending?.executionId).toBe('execution')
    expect(await adapter.pendingApprovals()).toHaveLength(1)
    await expect(adapter.run(resume('wrong-run', { type: 'approve' }, { executionId: 'other' }))).rejects.toThrow('another execution')
    expect(await adapter.run(resume())).toEqual(done)
    expect(driver.run).toHaveBeenCalledOnce()
    expect(callbacks.callTool).toHaveBeenCalledExactlyOnceWith({ runId: 'run-2', threadId: 'thread', name: 'write_file', args: write().args })
    expect((await adapter.state('thread')).interrupt).toBeNull()
    expect(store.value?.pending).toBeNull()
    expect(store.value?.inFlight).toBeNull()
  })

  it('applies edited arguments and refuses changing the approved tool name', async () => {
    const { adapter, callbacks } = setup(async (context) => {
      await context.tools!.call(write())
      return done
    })
    await adapter.run(request())
    await expect(adapter.run(resume('wrong', { type: 'edit', editedAction: { name: 'memory_search', args: {} } }))).rejects.toThrow('cannot change')
    await adapter.run(resume('edited', { type: 'edit', editedAction: { name: 'write_file', args: { file_path: '/workspace/edited.txt', content: 'edited' } } }))
    expect(callbacks.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'edited', args: { file_path: '/workspace/edited.txt', content: 'edited' } }),
    )
  })

  it('returns rejection to the engine and never executes the rejected tool', async () => {
    let toolResult: RuntimeToolResult | undefined
    const { adapter, callbacks } = setup(async (context) => {
      toolResult = await context.tools!.call(write())
      return done
    })
    await adapter.run(request())
    expect(await adapter.run(resume('rejected', { type: 'reject', message: 'No changes' }))).toEqual(done)
    expect(callbacks.callTool).not.toHaveBeenCalled()
    expect(toolResult).toEqual({ isError: true, content: [{ type: 'text', text: 'No changes' }] })
    expect(
      (await adapter.state('thread')).messages.some((message) => message.role === 'tool' && message.status === 'error' && message.content === 'No changes'),
    ).toBe(true)
  })

  it('serializes simultaneous tool requests and preserves approval order across segments', async () => {
    const { adapter, callbacks, driver } = setup(async (context) => {
      await Promise.all([context.tools!.call(write('first')), context.tools!.call(write('second'))])
      return done
    })
    expect((await adapter.run(request())).interrupted).toBe(true)
    const first = (await adapter.state('thread')).interrupt!.id
    expect((await adapter.run(resume('run-2'))).interrupted).toBe(true)
    const second = (await adapter.state('thread')).interrupt!.id
    expect(second).not.toBe(first)
    expect(callbacks.callTool).toHaveBeenCalledTimes(1)
    expect(await adapter.run(resume('run-3'))).toEqual(done)
    expect(vi.mocked(callbacks.callTool).mock.calls.map(([call]) => call.runId)).toEqual(['run-2', 'run-3'])
    expect(driver.run).toHaveBeenCalledOnce()
  })

  it('invalidates a cancelled waiting approval and does not launch another operation', async () => {
    const { adapter, callbacks } = setup(async (context) => {
      await context.tools!.call(write())
      return done
    })
    await adapter.run(request())
    adapter.abort('thread')
    await drain()
    expect(await adapter.pendingApprovals()).toEqual([])
    await expect(adapter.run(resume())).rejects.toThrow('no longer available')
    expect(callbacks.callTool).not.toHaveBeenCalled()
    expect(callbacks.unavailable).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'execution' }))
    const messages = vi.mocked(callbacks.event).mock.calls.flatMap(([event]) => (event.type === 'message' ? [event.message] : []))
    expect(messages.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ activity: { status: 'cancelled' } }] })
    expect(messages.at(-1)).toMatchObject({ role: 'tool', status: 'error', runtimeWarning: 'runtime_disconnected' })
  })

  it('invalidates an approval when its engine process exits', async () => {
    const death = pending<RunResult>()
    const { adapter, callbacks } = setup(async (context) => {
      void context.tools!.call(write())
      return death.promise
    })
    await adapter.run(request())
    death.reject(new Error('Engine exited'))
    await drain()
    expect(await adapter.pendingApprovals()).toEqual([])
    await expect(adapter.run(resume())).rejects.toThrow('no longer available')
    expect(callbacks.callTool).not.toHaveBeenCalled()
    expect(callbacks.unavailable).toHaveBeenCalledWith(expect.objectContaining({ error: 'Engine exited' }))
    const messages = vi.mocked(callbacks.event).mock.calls.flatMap(([event]) => (event.type === 'message' ? [event.message] : []))
    expect(messages.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ activity: { status: 'error' } }] })
    expect(messages.at(-1)).toMatchObject({ role: 'tool', status: 'error', runtimeWarning: 'runtime_disconnected' })
  })

  it('marks a persisted old approval disconnected on restart and never reuses its response channel', async () => {
    const original = setup(async (context) => {
      await context.tools!.call(write())
      return done
    })
    await original.adapter.run(request())
    const restoredStore = new MemoryStore()
    restoredStore.value = structuredClone(original.store.value)
    const restored = setup(async () => done, restoredStore)
    const state = await restored.adapter.state('thread')
    expect(state.interrupt).toBeNull()
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', status: 'error', runtimeWarning: 'runtime_disconnected' })
    await expect(restored.adapter.run(resume())).rejects.toThrow('no longer available')
    expect(restored.driver.run).not.toHaveBeenCalled()
    expect(restored.callbacks.callTool).not.toHaveBeenCalled()
  })

  it('requires fresh approval for a tool whose persisted previous outcome is unknown', async () => {
    const gate = pending<unknown>()
    const original = setup(async (context) => {
      await context.tools!.call(write())
      return done
    })
    original.callbacks.callTool = vi.fn(() => gate.promise)
    const originalRun = original.adapter.run(request({ interruptOn: [] }))
    await vi.waitFor(() => expect(original.store.value?.inFlight).toBeTruthy())
    const store = new MemoryStore()
    store.value = structuredClone(original.store.value)
    original.adapter.abort('thread')
    await originalRun
    gate.resolve('eventual old result')
    const restored = setup(async (context) => {
      await context.tools!.call(write('new-call'))
      return done
    }, store)
    const state = await restored.adapter.state('thread')
    expect(state.messages.at(-1)?.runtimeWarning).toBe('tool_outcome_unknown')
    expect(
      (
        await restored.adapter.run(
          request({
            runId: 'new-run',
            executionId: 'new-execution',
            interruptOn: [],
            input: { kind: 'message', id: 'next-user', text: 'Explicitly continue', images: [] },
          }),
        )
      ).interrupted,
    ).toBe(true)
    expect(restored.callbacks.callTool).not.toHaveBeenCalled()
    await restored.adapter.run(resume('new-resume', { type: 'reject' }, { executionId: 'new-execution', interruptOn: [] }))
  })

  it('deduplicates calls, rejects reused IDs and unknown names, and returns tool failures', async () => {
    const outputs: RuntimeToolResult[] = []
    const { adapter, callbacks } = setup(async (context) => {
      const a = { id: 'same', name: 'memory_search', args: { query: 'first' } }
      outputs.push(...(await Promise.all([context.tools!.call(a), context.tools!.call(a)])))
      outputs.push(await context.tools!.call({ ...a, args: { query: 'changed' } }))
      outputs.push(await context.tools!.call({ id: 'unknown', name: 'Bash', args: {} }))
      return done
    })
    callbacks.callTool = vi.fn(async () => {
      throw new Error('Tool unavailable')
    })
    await adapter.run(request({ interruptOn: [] }))
    expect(callbacks.callTool).toHaveBeenCalledOnce()
    expect(outputs[0]).toEqual(outputs[1])
    expect(outputs[0]).toMatchObject({ isError: true, content: [{ text: 'Tool unavailable' }] })
    expect(outputs[2].isError).toBe(true)
    expect(outputs[3].isError).toBe(true)
  })

  it('rechecks the available tool set on approval resume', async () => {
    let result: RuntimeToolResult | undefined
    const { adapter, callbacks } = setup(async (context) => {
      result = await context.tools!.call(write())
      return done
    })
    await adapter.run(request())
    await adapter.run(resume('changed-tools', { type: 'approve' }, { tools: [] }))
    expect(callbacks.callTool).not.toHaveBeenCalled()
    expect(result?.isError).toBe(true)
    const messages = vi.mocked(callbacks.event).mock.calls.flatMap(([event]) => (event.type === 'message' ? [event.message] : []))
    expect(messages.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ activity: { status: 'error' } }] })
    expect(messages.at(-1)).toMatchObject({ role: 'tool', status: 'error', content: 'Tool is no longer available' })
  })

  it('never overwrites a newer run when an old tool resolves after its engine exited', async () => {
    const effect = pending<unknown>()
    const death = pending<RunResult>()
    const { adapter, callbacks, store } = setup(async (context) => {
      if (context.request.runId === 'run-1') {
        context.saveSession({ sessionId: 'old-session' })
        void context.tools!.call(write())
        return death.promise
      }
      context.saveSession({ sessionId: 'new-session' })
      context.emit({ type: 'message', threadId: 'thread', message: { id: 'new-answer', role: 'assistant', content: 'New run is complete' } })
      return done
    })
    callbacks.callTool = vi.fn(() => effect.promise)
    const first = adapter.run(request({ interruptOn: [] }))
    await vi.waitFor(() => expect(store.value?.inFlight?.call.id).toBe('call-1'))
    const stopped = expect(first).rejects.toThrow('Engine exited during tool execution')
    death.reject(new Error('Engine exited during tool execution'))
    await stopped
    expect(store.value?.messages.at(-1)?.runtimeWarning).toBe('tool_outcome_unknown')
    await adapter.run(
      request({ runId: 'new-run', executionId: 'new-execution', input: { kind: 'message', id: 'new-user', text: 'Continue explicitly', images: [] } }),
    )
    const current = structuredClone(store.value)
    effect.resolve('A result from the old run')
    await drain()
    await drain()
    expect(store.value).toEqual(current)
    expect(store.value?.session).toEqual({ sessionId: 'new-session' })
    expect(store.value?.messages.map((message) => message.id)).toContain('new-answer')
    expect(callbacks.callTool).toHaveBeenCalledOnce()
    expect(
      vi.mocked(callbacks.event).mock.calls.some(([event]) => event.type === 'message' && event.message.content.includes('A result from the old run')),
    ).toBe(false)
  })

  it('rejects malformed edited arguments while keeping the original approval pending', async () => {
    const { adapter, callbacks } = setup(async (context) => {
      await context.tools!.call(write())
      return done
    })
    await adapter.run(request())
    const malformed = { type: 'edit', editedAction: { name: 'write_file', args: 'not-an-object' } } as unknown as Decision
    await expect(adapter.run(resume('malformed', malformed))).rejects.toThrow()
    expect(callbacks.callTool).not.toHaveBeenCalled()
    expect(await adapter.pendingApprovals()).toHaveLength(1)
  })

  it('cancels an in-flight operation without executing the queued next tool or reviving deleted history', async () => {
    const gate = pending<unknown>()
    const { adapter, callbacks, store } = setup(async (context) => {
      await Promise.all([context.tools!.call(write('first')), context.tools!.call(write('second'))])
      return done
    })
    callbacks.callTool = vi.fn(() => gate.promise)
    const running = adapter.run(request({ interruptOn: [] }))
    await vi.waitFor(() => expect(callbacks.callTool).toHaveBeenCalledOnce())
    await adapter.deleteThread('thread')
    expect((await running).aborted).toBe(true)
    gate.resolve('late effect')
    await drain()
    expect(callbacks.callTool).toHaveBeenCalledOnce()
    expect(store.value).toBeNull()
    await expect(adapter.run(request())).rejects.toThrow('no longer available')
  })

  it('normalizes legacy DSML history without launching an engine or executing embedded code', async () => {
    const store = new MemoryStore()
    const message: UIMessage = {
      id: 'old',
      role: 'assistant',
      content:
        'Before <｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls> After',
    }
    store.value = { kind: 'claude', session: { sessionId: 'old' }, messages: [message] }
    const { adapter, callbacks, driver } = setup(async () => done, store)
    expect((await adapter.state('thread')).messages).toEqual([{ ...message, content: 'Before  After', runtimeWarning: 'unexecuted_tool_markup' }])
    expect(driver.run).not.toHaveBeenCalled()
    expect(callbacks.callTool).not.toHaveBeenCalled()
  })
})
