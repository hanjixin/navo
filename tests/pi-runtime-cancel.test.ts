import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { PiSnapshot } from '../src/main/pi-host/runner'

const mock = vi.hoisted(() => ({ database: null as unknown as Database.Database, abort: vi.fn(async () => {}) }))
vi.mock('../src/main/core/db', () => ({ db: () => mock.database }))
vi.mock('../src/main/agent-runtime/builtin', () => ({
  BuiltinRuntimeAdapter: class {
    abort = mock.abort
  },
}))
import { PiRuntimeAdapter } from '../src/main/agent-runtime/pi'
import { PiStateStore } from '../src/main/agent-runtime/pi-state'

let database: DatabaseSync
beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec(
    "CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,runtime_id TEXT); INSERT INTO threads VALUES('thread','pi')",
  )
  mock.database = database as unknown as Database.Database
  mock.abort.mockReset().mockResolvedValue(undefined)
})
afterEach(() => database.close())

function setup() {
  const store = new PiStateStore(mock.database)
  const call = fauxToolCall('lookup', {}, { id: 'call' })
  const snapshot: PiSnapshot = {
    messages: [],
    ui: [],
    inFlight: null,
    pending: {
      assistant: fauxAssistantMessage(call, { stopReason: 'toolUse' }),
      calls: [call],
      approved: false,
      interrupt: { id: 'approval', actionRequests: [{ name: 'lookup', args: {} }], allowedDecisions: [['approve', 'reject']] },
    },
  }
  store.write('thread', snapshot)
  const event = vi.fn()
  const runtime = new PiRuntimeAdapter({ event, callTool: vi.fn(), workspaceWrite: vi.fn(), usage: vi.fn() })
  return { store, snapshot, event, runtime }
}

it('clears an approval restored from SQLite even when abort has no worker to notify', async () => {
  const { runtime, store, event } = setup()
  await runtime.abort('thread')
  expect(mock.abort).toHaveBeenCalledWith('thread')
  expect(await runtime.pendingApprovals()).toEqual([])
  expect(store.read('thread')).toMatchObject({ pending: null, inFlight: null, messages: [expect.objectContaining({ role: 'toolResult', isError: true })] })
  expect(event).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.objectContaining({ status: 'error' }) }))
})

it('clears the original persisted approval when the worker abort RPC fails', async () => {
  const { runtime, store } = setup()
  mock.abort.mockRejectedValueOnce(new Error('worker disconnected'))
  await expect(runtime.abort('thread')).rejects.toThrow('worker disconnected')
  expect(store.read('thread')).toMatchObject({ pending: null, inFlight: null })
  expect(await runtime.pendingApprovals()).toEqual([])
})

it.each(['resolved', 'rejected'] as const)('does not clear a newer approval after a delayed %s abort response', async (response) => {
  const { runtime, store, snapshot, event } = setup()
  let resolve!: () => void
  let reject!: (error: Error) => void
  mock.abort.mockImplementationOnce(
    () =>
      new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
      }),
  )
  const pending = runtime.abort('thread')
  snapshot.pending!.interrupt.id = 'new-approval'
  store.write('thread', snapshot)
  if (response === 'rejected') {
    const failed = expect(pending).rejects.toThrow('worker disconnected')
    reject(new Error('worker disconnected'))
    await failed
  } else {
    resolve()
    await pending
  }
  expect(store.read('thread')?.pending?.interrupt.id).toBe('new-approval')
  expect(event).not.toHaveBeenCalled()
})
