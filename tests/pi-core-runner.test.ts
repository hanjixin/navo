import { describe, expect, it, vi } from 'vitest'
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { PiRunner, type PiSnapshot } from '../src/main/pi-host/runner'
import { piModel } from '../src/main/pi-host/model'
import type { RunRequest } from '../src/main/agent-runtime/contracts'
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
    stream: () => faux.streamSimple,
  }
  return { runner: new PiRunner(deps), deps, snapshots, callTool, faux, emit }
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
  it.each(['anthropic', 'openai', 'openai-responses', 'openai-compatible'] as const)('maps %s custom model without loading keys from disk', (type) => {
    const model = piModel({ ...request().model, providerType: type, baseURL: 'http://127.0.0.1:9999', headers: { 'x-test': 'yes' }, apiKey: 'secret' })
    expect(model.baseUrl).toBe('http://127.0.0.1:9999')
    expect(model.headers).toEqual({ 'x-test': 'yes' })
    expect(JSON.stringify(model)).not.toContain('secret')
    expect(model.api).toBe(type === 'anthropic' ? 'anthropic-messages' : type === 'openai-responses' ? 'openai-responses' : 'openai-completions')
  })
})
