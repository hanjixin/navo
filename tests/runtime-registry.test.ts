import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { ExternalRuntimeContext, ExternalRuntimeDriver, RuntimeCallbacks } from '../src/main/agent-runtime/types'
import type { RunRequest, RunResult } from '../src/main/agent-host/protocol'

const state = vi.hoisted(() => ({ database: null as unknown as Database.Database, pending: vi.fn(async () => []) }))
vi.mock('../src/main/core/db', () => ({
  db: () => state.database,
  kv: {
    get: (key: string, fallback: unknown) => {
      const row = state.database.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined
      return row ? JSON.parse(row.value) : fallback
    },
    set: (key: string, value: unknown) => state.database.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(key, JSON.stringify(value)),
  },
}))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/paths', () => ({ paths: { userData: '/tmp/runtime-tests' } }))
vi.mock('../src/main/core/shell-env', () => ({ shellPath: () => process.env.PATH }))
vi.mock('../src/main/agent-runtime/builtin', () => ({
  BuiltinRuntimeAdapter: class {
    pendingApprovals = state.pending
  },
}))
import { RuntimeRegistry } from '../src/main/agent-runtime/registry'
import { SubmissionStore } from '../src/main/chat/submissions'
import { ExternalRuntimeAdapter } from '../src/main/agent-runtime/external'

let sqlite: DatabaseSync
let registry: RuntimeRegistry
let callbacks: RuntimeCallbacks
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const match of source.matchAll(/`([\s\S]*?)`/g)) sqlite.exec(match[1])
  state.database = sqlite as unknown as Database.Database
  registry = new RuntimeRegistry()
  callbacks = { event: vi.fn(), callTool: vi.fn(async () => undefined), workspaceWrite: vi.fn(), usage: vi.fn() }
  state.pending.mockReset().mockResolvedValue([])
})
afterEach(() => sqlite.close())
function thread(id = 'thread'): void {
  sqlite.prepare('INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, id, 1, 1)
}
function configured() {
  return registry.save({ ...registry.info('claude').profile, enabled: true, command: '/custom/claude', model: 'old-model' }).profile
}
function request(): RunRequest {
  return {
    runId: 'run',
    executionId: 'execution',
    threadId: 'thread',
    input: { kind: 'message', id: 'user', text: 'Hello', images: [] },
    model: { providerType: 'openai-compatible', model: 'claude', supportsVision: false },
    systemPrompt: '',
    tools: [],
    interruptOn: [],
    browserSubagent: false,
    mounts: [],
    paths: { workspace: '/tmp', uploads: '/tmp', skills: '/tmp' },
    devMode: false,
    meta: { threadTitle: 'Thread', modelLabel: 'Claude', appVersion: 'test' },
  }
}
function driver(run: ExternalRuntimeDriver['run']): ExternalRuntimeDriver {
  return { kind: 'claude', capabilities: registry.info('claude').capabilities, run }
}

describe('runtime bindings', () => {
  it('defaults legacy conversations to builtin and snapshots configuration for new conversations', () => {
    thread('legacy')
    expect(registry.profile('legacy').kind).toBe('builtin')
    thread()
    const profile = configured()
    registry.bind('thread', profile)
    registry.save({ ...profile, command: '/new/claude', model: 'new-model' })
    expect(registry.profile('thread')).toMatchObject({ command: '/custom/claude', model: 'old-model' })
    expect(registry.capture('claude')).toMatchObject({ command: '/new/claude', model: 'new-model' })
    expect(() => registry.bind('thread', registry.capture())).toThrow('cannot change')
  })
  it('disabling blocks new capture while preserving historical access and its configuration', async () => {
    thread()
    const profile = configured()
    registry.bind('thread', profile)
    registry.save({ ...profile, enabled: false })
    expect(() => registry.capture('claude')).toThrow('disabled')
    expect(registry.profile('thread')).toMatchObject({ enabled: false, command: '/custom/claude' })
    expect(await registry.get('thread', callbacks).state('thread')).toMatchObject({ messages: [] })
  })
  it('filters approval recovery by persisted runtime ownership', async () => {
    thread('legacy')
    thread()
    registry.bind('thread', configured())
    state.pending.mockResolvedValue([
      { threadId: 'legacy', interrupt: {} },
      { threadId: 'thread', interrupt: {} },
      { threadId: 'deleted', interrupt: {} },
    ] as never)
    expect(await registry.pendingApprovals(callbacks)).toEqual([{ threadId: 'legacy', interrupt: {} }])
  })
})

describe('external engine session persistence', () => {
  it('persists the acknowledged user before live state can mark the durable submission checkpointed', async () => {
    thread()
    const profile = configured()
    const store = new SubmissionStore(() => state.database)
    store.accept(
      { requestId: 'crash', threadId: 'thread', messageId: 'user', executionId: 'execution' },
      'payload',
      { id: 'user', role: 'user', content: 'Hello' },
      request().input,
    )
    let complete!: (result: RunResult) => void
    const adapter = new ExternalRuntimeAdapter(
      'thread',
      profile,
      driver((context) => {
        context.emit({ type: 'token', threadId: 'thread', messageId: 'assistant', text: 'First' })
        return new Promise((resolve) => {
          complete = resolve
        })
      }),
      callbacks,
    )
    const pending = adapter.run(request())
    store.merge('thread', (await adapter.state('thread')).messages)
    expect(store.recoverable('thread')).toEqual([])
    const restarted = new ExternalRuntimeAdapter(
      'thread',
      profile,
      driver(async () => ({ finalText: '', interrupted: false })),
      callbacks,
    )
    expect((await restarted.state('thread')).messages.some((message) => message.id === 'user')).toBe(true)
    complete({ finalText: 'First', interrupted: false })
    await pending
  })
  it('normalizes a driver rejection caused by cancellation into an aborted result', async () => {
    const adapter = new ExternalRuntimeAdapter(
      'thread',
      configured(),
      driver(
        (context) =>
          new Promise((_, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true })
          }),
      ),
      callbacks,
    )
    const pending = adapter.run(request())
    adapter.abort('thread')
    await expect(pending).resolves.toMatchObject({ aborted: true, interrupted: false })
    expect(callbacks.event).not.toHaveBeenCalled()
  })
  it('keeps a failed unacknowledged message recoverable and checkpoints it only after explicit successful retry', async () => {
    thread()
    const profile = configured()
    const submitted = request()
    const store = new SubmissionStore(() => state.database)
    store.accept(
      { requestId: 'request', threadId: 'thread', messageId: 'user', executionId: 'execution' },
      'payload',
      { id: 'user', role: 'user', content: 'Hello' },
      submitted.input,
    )
    let fail = true
    const adapter = new ExternalRuntimeAdapter(
      'thread',
      profile,
      driver(async (context) => {
        if (fail) {
          context.saveSession({ id: 'started-but-not-accepted' })
          expect((await adapter.state('thread')).messages).toEqual([])
          throw new Error('Connection failed before message accepted')
        }
        expect(context.session).toEqual({ id: 'started-but-not-accepted' })
        context.emit({ type: 'token', threadId: 'thread', messageId: 'assistant', text: 'Hi' })
        return { finalText: 'Hi', interrupted: false }
      }),
      callbacks,
    )
    await expect(adapter.run(submitted)).rejects.toThrow('Connection failed')
    store.merge('thread', (await adapter.state('thread')).messages)
    expect(store.recoverable('thread')).toEqual(['user'])
    fail = false
    await adapter.run(submitted)
    store.merge('thread', (await adapter.state('thread')).messages)
    expect(store.recoverable('thread')).toEqual([])
    expect((await adapter.state('thread')).messages.map((message) => message.id)).toEqual(['user', 'assistant'])
  })
  it('reloads opaque engine session and display history in a new adapter', async () => {
    const profile = configured()
    const first = new ExternalRuntimeAdapter(
      'thread',
      profile,
      driver(async (context) => {
        context.saveSession({ id: 'opaque' })
        context.emit({ type: 'message', threadId: 'thread', message: { id: 'assistant', role: 'assistant', content: 'Hi' } })
        return { finalText: 'Hi', interrupted: false }
      }),
      callbacks,
    )
    await first.run(request())
    const run = vi.fn(async (context: ExternalRuntimeContext) => {
      expect(context.session).toEqual({ id: 'opaque' })
      return { finalText: '', interrupted: false }
    })
    const second = new ExternalRuntimeAdapter('thread', profile, driver(run), callbacks)
    expect((await second.state('thread')).messages.map((m) => m.id)).toEqual(['user', 'assistant'])
    await second.run({ ...request(), input: { kind: 'message', id: 'next', text: 'Continue', images: [] } })
    expect(run).toHaveBeenCalledOnce()
  })
  it('aborts execution and ignores late output, session and usage callbacks', async () => {
    const profile = configured()
    let context!: ExternalRuntimeContext
    let complete!: (result: RunResult) => void
    const adapter = new ExternalRuntimeAdapter(
      'thread',
      profile,
      driver((ctx) => {
        context = ctx
        return new Promise((resolve) => {
          complete = resolve
        })
      }),
      callbacks,
    )
    const pending = adapter.run(request())
    adapter.abort('thread')
    expect(context.signal.aborted).toBe(true)
    context.saveSession({ id: 'late' })
    context.emit({ type: 'message', threadId: 'thread', message: { id: 'late', role: 'assistant', content: 'Late' } })
    context.usage({ threadId: 'thread', model: 'test', usage: { input: 1, output: 1, cached: 0 } })
    complete({ finalText: 'Late', interrupted: false })
    expect((await pending).aborted).toBe(true)
    expect(callbacks.event).not.toHaveBeenCalled()
    expect(callbacks.usage).not.toHaveBeenCalled()
    expect((await adapter.state('thread')).messages).toEqual([])
  })
  it('never restores session data when a deleted conversation finishes asynchronously', async () => {
    const profile = configured()
    let context!: ExternalRuntimeContext
    let complete!: (result: RunResult) => void
    const adapter = new ExternalRuntimeAdapter(
      'thread',
      profile,
      driver((ctx) => {
        context = ctx
        context.saveSession({ id: 'before' })
        return new Promise((resolve) => {
          complete = resolve
        })
      }),
      callbacks,
    )
    const pending = adapter.run(request())
    await adapter.deleteThread('thread')
    context.saveSession({ id: 'after' })
    complete({ finalText: '', interrupted: false })
    await pending
    expect(sqlite.prepare('SELECT value FROM kv WHERE key=?').get('runtime.session:thread')).toBeUndefined()
    await expect(adapter.run(request())).rejects.toThrow('no longer available')
  })
})
