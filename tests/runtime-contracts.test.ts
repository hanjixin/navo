import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
const runtimeState = vi.hoisted(() => ({ database: null as unknown as Database.Database }))
vi.mock('../src/main/core/paths', () => ({ paths: { userData: '/tmp/runtime-contracts' } }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/shell-env', () => ({ shellPath: () => process.env.PATH ?? '' }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/runtime-contracts' } }))
vi.mock('../src/main/core/db', () => ({
  db: () => runtimeState.database,
  kv: {
    get: (_key: string, fallback: unknown) => fallback,
    set: vi.fn(),
  },
}))
import { KvRuntimeStateStore } from '../src/main/agent-runtime/state-store'
import { toolBridgeFromCallbacks } from '../src/main/agent-runtime/tool-bridge'
import type { RuntimeCallbacks } from '../src/main/agent-runtime/types'
import { RuntimeRegistry } from '../src/main/agent-runtime/registry'
import type { RuntimeModel } from '../src/main/agent-runtime/contracts'
import type { ModelAdapter } from '../src/main/agent-runtime/model-adapter'

describe('agent runtime contracts', () => {
  it('keeps state stores engine-neutral and isolated by namespace', () => {
    const database = new DatabaseSync(':memory:') as unknown as Database.Database
    database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const pi = new KvRuntimeStateStore<{ session: string }>(database, 'pi.state')
    const claude = new KvRuntimeStateStore<{ session: string }>(database, 'claude.state')

    pi.write('thread-1', { session: 'pi-1' })
    claude.write('thread-1', { session: 'claude-1' })
    expect(pi.read('thread-1')).toEqual({ session: 'pi-1' })
    expect(claude.read('thread-1')).toEqual({ session: 'claude-1' })
    pi.remove('thread-1')
    expect(pi.read('thread-1')).toBeNull()
    expect(claude.read('thread-1')).toEqual({ session: 'claude-1' })
    database.close()
  })

  it('exposes tool execution and workspace writes through one bridge', async () => {
    const callTool = vi.fn(async () => ({ ok: true }))
    const workspaceWrite = vi.fn()
    const callbacks = { callTool, workspaceWrite, event: vi.fn(), usage: vi.fn() } as unknown as RuntimeCallbacks
    const bridge = toolBridgeFromCallbacks(callbacks)
    const request = { runId: 'run', threadId: 'thread', name: 'memory_search', args: { query: 'hello' } }
    expect(await bridge.call(request)).toEqual({ ok: true })
    await bridge.writeWorkspace({ runId: 'run', threadId: 'thread', path: '/workspace/a.txt' })
    expect(callTool).toHaveBeenCalledWith(request)
    expect(workspaceWrite).toHaveBeenCalledWith({ runId: 'run', threadId: 'thread', path: '/workspace/a.txt' })
  })

  it('advertises capabilities by runtime instead of requiring engine checks', () => {
    runtimeState.database = new DatabaseSync(':memory:') as unknown as Database.Database
    runtimeState.database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL DEFAULT 'builtin', runtime_config TEXT)")
    const registry = new RuntimeRegistry()
    expect(registry.info('builtin').capabilities).toMatchObject({ navoTools: true, approvals: true, fork: true })
    expect(registry.info('pi').capabilities).toMatchObject({ navoTools: true, approvals: true, nativeTools: false, fork: false })
    expect(registry.info('claude').capabilities).toMatchObject({ navoTools: false, nativeTools: false, approvals: false })
    expect(registry.info('codex').capabilities).toMatchObject({ navoTools: false, nativeTools: true, approvals: false })
    runtimeState.database.close()
  })

  it('keeps model conversion behind an engine-neutral adapter contract', () => {
    const adapter: ModelAdapter<{ id: string }, { provider: string }> = {
      model: (config: RuntimeModel) => ({ id: config.model }),
      stream: (config: RuntimeModel) => ({ provider: config.providerType }),
    }
    expect(adapter.model({ providerType: 'openai', model: 'gpt-test', supportsVision: false })).toEqual({ id: 'gpt-test' })
    expect(adapter.stream({ providerType: 'openai', model: 'gpt-test', supportsVision: false })).toEqual({ provider: 'openai' })
  })
})
