import { describe, expect, it, vi } from 'vitest'
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { PiRunner, type PiSnapshot } from '../src/main/pi-host/runner'
import { piModel } from '../src/main/pi-host/model'
import type { RunRequest } from '../src/main/agent-runtime/contracts'
import type { Context } from '@earendil-works/pi-ai'
function request(): RunRequest {
  return {
    runId: 'run',
    threadId: 'thread',
    input: { kind: 'message', id: 'user', text: 'hello', images: [] },
    model: { providerType: 'openai-compatible', model: 'model', supportsVision: false },
    systemPrompt: 'You are helpful',
    tools: [
      { name: 'lookup', description: 'lookup', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, source: 'navo' },
    ],
    interruptOn: [],
    browserSubagent: false,
    mounts: [],
    paths: { workspace: '/tmp', skills: '/tmp', uploads: '/tmp' },
    devMode: false,
    meta: { threadTitle: 't', modelLabel: 'm', appVersion: 'test' },
  }
}
function setup(responses: FauxResponseStep[]) {
  const snapshots = new Map<string, PiSnapshot>()
  const faux = createFauxCore({ models: [{ id: 'model' }], tokensPerSecond: 0 })
  faux.setResponses(responses)
  const callTool = vi.fn(async () => 'found')
  const emit = vi.fn()
  const usage = vi.fn()
  const contexts: Context[] = []
  const deps = {
    read: (id: string) => structuredClone(snapshots.get(id) ?? null),
    write: (id: string, s: PiSnapshot) => {
      snapshots.set(id, structuredClone(s))
    },
    remove: (id: string) => {
      snapshots.delete(id)
    },
    list: () => [...snapshots.keys()],
    emit,
    usage,
    callTool,
    stream:
      () =>
      (...args: Parameters<typeof faux.streamSimple>) => {
        contexts.push(structuredClone(args[1]))
        return faux.streamSimple(...args)
      },
  }
  return { runner: new PiRunner(deps), deps, snapshots, callTool, faux, emit, contexts }
}
describe('bundled Pi core', () => {
  it('streams a turn and persists it without invoking an external executable', async () => {
    const f = setup([fauxAssistantMessage('hello')])
    expect(await f.runner.run(request())).toMatchObject({ finalText: 'hello', interrupted: false })
    expect(f.runner.state('thread').messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
  it('runs a Navo tool and continues with its actual result', async () => {
    const f = setup([fauxAssistantMessage(fauxToolCall('lookup', { query: 'q' }, { id: 'call' }), { stopReason: 'toolUse' }), fauxAssistantMessage('answer')])
    expect(await f.runner.run(request())).toMatchObject({ finalText: 'answer' })
    expect(f.callTool).toHaveBeenCalledWith({ runId: 'run', threadId: 'thread', name: 'lookup', args: { query: 'q' } })
    expect(f.runner.state('thread').messages.some((m) => m.role === 'tool' && m.content === 'found')).toBe(true)
  })
  it('persists approval before any side effect and resumes on a fresh runner', async () => {
    const f = setup([fauxAssistantMessage(fauxToolCall('lookup', { query: 'q' }, { id: 'call' }), { stopReason: 'toolUse' }), fauxAssistantMessage('approved')])
    const req = request()
    req.interruptOn = ['lookup']
    expect(await f.runner.run(req)).toMatchObject({ interrupted: true })
    expect(f.callTool).not.toHaveBeenCalled()
    const restored = new PiRunner(f.deps)
    expect(restored.pendingApprovals()).toHaveLength(1)
    expect(await restored.run({ ...req, runId: 'resume', input: { kind: 'resume', decisions: [{ type: 'approve' }] } })).toMatchObject({
      finalText: 'approved',
      interrupted: false,
    })
    expect(f.callTool).toHaveBeenCalledTimes(1)
    expect(restored.pendingApprovals()).toHaveLength(0)
  })
  it('rejects a pending call without running it', async () => {
    const f = setup([fauxAssistantMessage(fauxToolCall('lookup', { query: 'q' }, { id: 'call' }), { stopReason: 'toolUse' }), fauxAssistantMessage('rejected')])
    const req = request()
    req.interruptOn = ['lookup']
    await f.runner.run(req)
    await f.runner.run({ ...req, input: { kind: 'resume', decisions: [{ type: 'reject' }] } })
    expect(f.callTool).not.toHaveBeenCalled()
    expect(f.runner.state('thread').messages.some((m) => m.status === 'error')).toBe(true)
  })
  it('cancels a paused approval durably and accepts a new message after restart', async () => {
    const f = setup([fauxAssistantMessage(fauxToolCall('lookup', { query: 'q' }, { id: 'call' }), { stopReason: 'toolUse' }), fauxAssistantMessage('new turn')])
    const req = { ...request(), interruptOn: ['lookup'] }
    expect(await f.runner.run(req)).toMatchObject({ interrupted: true })
    f.runner.abort(req.threadId)
    f.runner.abort(req.threadId)
    const restored = new PiRunner(f.deps)
    expect(restored.pendingApprovals()).toEqual([])
    expect(f.callTool).not.toHaveBeenCalled()
    expect(f.snapshots.get(req.threadId)?.messages.filter((message) => message.role === 'toolResult')).toHaveLength(1)
    expect(restored.state(req.threadId).messages.at(-1)).toMatchObject({ status: 'error', content: expect.stringContaining('cancelled') })
    await expect(restored.run({ ...req, input: { kind: 'resume', decisions: [{ type: 'approve' }] } })).rejects.toThrow('no longer pending')
    expect(await restored.run({ ...req, input: { kind: 'message', id: 'next', text: 'continue', images: [] } })).toMatchObject({ finalText: 'new turn' })
    expect(f.callTool).not.toHaveBeenCalled()
  })
  it('cancels a persisted approval without an active run', async () => {
    const f = setup([fauxAssistantMessage(fauxToolCall('lookup', { query: 'q' }, { id: 'call' }), { stopReason: 'toolUse' })])
    await f.runner.run({ ...request(), interruptOn: ['lookup'] })
    new PiRunner(f.deps).abort('thread')
    expect(new PiRunner(f.deps).pendingApprovals()).toEqual([])
    expect(f.snapshots.get('thread')?.inFlight).toBeNull()
  })
  it('retains unknown side effects after cancellation and ignores late tool results', async () => {
    const f = setup([
      fauxAssistantMessage([fauxToolCall('lookup', { query: 'first' }, { id: 'first' }), fauxToolCall('lookup', { query: 'second' }, { id: 'second' })], {
        stopReason: 'toolUse',
      }),
    ])
    let complete!: (value: string) => void
    f.callTool.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve
        }),
    )
    const running = f.runner.run(request())
    await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(1))
    f.runner.abort('thread')
    complete('late success')
    expect(await running).toMatchObject({ aborted: true, interrupted: false })
    const saved = f.snapshots.get('thread')!
    expect(saved.pending).toBeNull()
    expect(saved.inFlight).toBe('first')
    expect(saved.ui.filter((message) => message.role === 'tool')).toEqual([
      expect.objectContaining({ toolCallId: 'first', status: 'error', runtimeWarning: 'tool_outcome_unknown' }),
      expect.objectContaining({ toolCallId: 'second', status: 'error', content: expect.stringContaining('before execution') }),
    ])
    await expect(new PiRunner(f.deps).run(request())).rejects.toThrow('outcome is unknown')
    expect(f.callTool).toHaveBeenCalledTimes(1)
  })
  it('sends image blocks to the model and preserves user image presentation', async () => {
    const f = setup([fauxAssistantMessage('seen')])
    const image = 'data:image/png;base64,aGVsbG8='
    const req = request()
    await f.runner.run({ ...req, model: { ...req.model, supportsVision: true }, input: { kind: 'message', id: 'picture', text: 'describe', images: [image] } })
    expect(f.contexts[0].messages.find((message) => message.role === 'user')?.content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ])
    expect(f.runner.state('thread').messages[0].images).toEqual([image])
  })
  it('rejects image inputs before submitting to a model without vision', async () => {
    const f = setup([])
    await expect(
      f.runner.run({ ...request(), input: { kind: 'message', id: 'picture', text: '', images: ['data:image/png;base64,aGVsbG8='] } }),
    ).rejects.toThrow('does not support images')
    expect(f.contexts).toEqual([])
  })
  it.each(['mcp', 'langchain'] as const)('preserves %s tool image blocks and errors for the model and history', async (format) => {
    const f = setup([fauxAssistantMessage(fauxToolCall('lookup', { query: 'q' }, { id: 'call' }), { stopReason: 'toolUse' }), fauxAssistantMessage('seen')])
    const image = 'data:image/png;base64,aGVsbG8='
    f.deps.callTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: 'screenshot' },
        format === 'mcp' ? { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' } : { type: 'image_url', image_url: { url: image } },
      ],
      isError: true,
    })) as unknown as typeof f.deps.callTool
    await new PiRunner(f.deps).run(request())
    expect(f.contexts[1].messages.find((message) => message.role === 'toolResult')).toMatchObject({
      isError: true,
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    })
    expect(f.runner.state('thread').messages.find((message) => message.role === 'tool')).toMatchObject({
      content: 'screenshot',
      images: [image],
      status: 'error',
    })
  })
  it('refreshes the Navo system prompt each turn while retaining Pi tool declarations', async () => {
    const f = setup([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    await f.runner.run({ ...request(), systemPrompt: 'Old project and memory' })
    await f.runner.run({ ...request(), systemPrompt: 'New project and memory' })
    const systems = f.contexts[1].messages.filter((message) => message.role === 'system')
    expect(systems[0].content).toBe('New project and memory')
    expect(systems.some((message) => message.content === 'Old project and memory')).toBe(false)
    expect(systems.some((message) => 'toolsAdded' in message)).toBe(true)
  })
  it.each(['anthropic', 'openai', 'openai-responses', 'openai-compatible'] as const)('maps %s custom model without loading keys from disk', (type) => {
    const model = piModel({ ...request().model, providerType: type, baseURL: 'http://127.0.0.1:9999', headers: { 'x-test': 'yes' }, apiKey: 'secret' })
    expect(model.baseUrl).toBe('http://127.0.0.1:9999')
    expect(model.headers).toEqual({ 'x-test': 'yes' })
    expect(JSON.stringify(model)).not.toContain('secret')
    expect(model.api).toBe(type === 'anthropic' ? 'anthropic-messages' : type === 'openai-responses' ? 'openai-responses' : 'openai-completions')
  })
})
