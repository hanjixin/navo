import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { ThreadState } from '../src/shared/types'
import type { Rpc } from '../src/main/agent-host/rpc'
import type { RunRequest, RunResult } from '../src/main/agent-host/protocol'

const state = vi.hoisted(() => ({
  database: null as unknown as Database.Database,
  waitFiles: null as null | Promise<unknown[]>,
  enabled: true,
  checkpoint: { messages: [], todos: [], interrupt: null } as Omit<ThreadState, 'running'>,
  result: { finalText: '', interrupted: false } as RunResult,
  runs: [] as RunRequest[],
  approvals: [] as { threadId: string; interrupt: NonNullable<ThreadState['interrupt']> }[],
}))
vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, utilityProcess: {} }))
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
vi.mock('../src/main/core/app-dir', () => ({ appFile: () => '' }))
vi.mock('../src/main/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/main/core/paths', () => ({ paths: { workspace: '/tmp', uploads: '/tmp', skills: '/tmp' } }))
vi.mock('../src/main/core/settings', () => ({ getSettings: () => ({ approvalTools: [] }), langfuseConfig: () => undefined }))
vi.mock('../src/main/files/attachments', () => ({
  buildAttachmentContext: () => ({ context: 'file snapshot', attachments: [{ id: 'f', name: 'file' }], images: [] }),
}))
vi.mock('../src/main/files/file-service', () => ({ files: { waitFor: () => state.waitFiles ?? Promise.resolve([]), get: () => ({ name: 'file' }) } }))
vi.mock('../src/main/flows/flows', () => ({ flows: { onRunEnd: vi.fn() } }))
vi.mock('../src/main/flows/trace', () => ({ trace: { start: vi.fn() } }))
vi.mock('../src/main/learning', () => ({ learning: {} }))
vi.mock('../src/main/memory/memory-service', () => ({ memory: { forRun: () => null } }))
vi.mock('../src/main/memory/recall', () => ({ hostOf: () => null }))
vi.mock('../src/main/browser/agent-session', () => ({ sessions: { begin: vi.fn(), end: vi.fn(), peek: () => null } }))
vi.mock('../src/main/models/registry', () => ({
  resolveModel: () => {
    if (!state.enabled) throw new Error('disabled model')
    return { supportsVision: false, model: 'test' }
  },
}))
vi.mock('../src/main/skills/skill-service', () => ({ skills: { mounts: () => [] } }))
vi.mock('../src/main/usage/usage-service', () => ({ usage: {} }))
vi.mock('../src/main/outputs/outputs-service', () => ({ outputs: {} }))
vi.mock('../src/main/connectors/builtin', () => ({ BUILTIN_SEND_TOOLS: [] }))
vi.mock('../src/main/connectors/connector-service', () => ({ connectors: { writeTools: () => [] } }))
vi.mock('../src/main/mcp-server/tools', () => ({ isSpawnedConversation: () => false }))
vi.mock('../src/main/agent/tool-registry', () => ({ collectTools: () => [], describeTools: () => [], NAVO_DESTRUCTIVE: [], systemPrompt: () => '' }))
vi.mock('../src/main/external-browser/instance', () => ({ targets: { get: () => 'builtin' } }))
vi.mock('../src/main/computer-use', () => ({ computerUse: { beginRun: vi.fn(), endRun: vi.fn(), endExecution: vi.fn(), stopRun: vi.fn() } }))
vi.mock('../src/main/projects/project-service', () => ({ projects: { exists: () => true, get: () => null } }))
vi.mock('../src/main/projects/project-files', () => ({ projectFiles: { captureReferences: async () => ({ fileIds: [], sources: {} }) } }))

import { AgentService, type ExecutionEvent } from '../src/main/agent/agent-service'
import { drafts } from '../src/main/chat/drafts'
import { submissions } from '../src/main/chat/submissions'

let sqlite: DatabaseSync
let agent: AgentService
const drain = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const m of source.matchAll(/`([\s\S]*?)`/g)) sqlite.exec(m[1])
  let count = 0
  state.database = Object.assign(sqlite, {
    transaction:
      <T>(fn: () => T) =>
      () => {
        const name = `test_${++count}`
        sqlite.exec(`SAVEPOINT ${name}`)
        try {
          const out = fn()
          sqlite.exec(`RELEASE ${name}`)
          return out
        } catch (e) {
          sqlite.exec(`ROLLBACK TO ${name}`)
          sqlite.exec(`RELEASE ${name}`)
          throw e
        }
      },
  }) as unknown as Database.Database
  state.waitFiles = null
  state.enabled = true
  state.checkpoint = { messages: [], todos: [], interrupt: null }
  state.result = { finalText: '', interrupted: false }
  state.runs = []
  state.approvals = []
  agent = new AgentService()
  const rpc = {
    call: vi.fn(async (method: string, req: RunRequest) => {
      if (method === 'approvals.recover') return state.approvals
      if (method === 'thread.state') return state.checkpoint
      if (method === 'run.start') {
        state.runs.push(req)
        return state.result
      }
      return undefined
    }),
  }
  vi.spyOn(agent as unknown as { host(): Rpc }, 'host').mockReturnValue(rpc as unknown as Rpc)
})
afterEach(async () => {
  await drain()
  vi.restoreAllMocks()
  sqlite.close()
})

describe('submission acceptance and run coordination', () => {
  it('acknowledges one durable message before starting, and retries the receipt without duplicate execution', async () => {
    const input = { requestId: 'same', text: 'Hello' }
    const [a, b] = await Promise.all([agent.submit(input), agent.submit(input)])
    expect(a).toEqual(b)
    expect(state.runs).toHaveLength(0)
    expect(agent.listThreads()).toHaveLength(1)
    expect((await agent.threadState(a.threadId)).messages).toHaveLength(1)
    await drain()
    expect(state.runs).toHaveLength(1)
    expect(await agent.submit(input)).toEqual(a)
    await drain()
    expect(state.runs).toHaveLength(1)
    await expect(agent.submit({ ...input, text: 'other' })).rejects.toThrow('different content')
  })
  it('locks a thread throughout file preparation across both APIs and preserves drafts on cancellation', async () => {
    const thread = agent.createThread()
    const scope = { surface: 'main' as const, threadId: thread.id }
    const draft = drafts.save({ scope, text: 'Keep me', fileIds: ['f'], projectFiles: [], modelId: null, expectedVersion: 0 })
    let finish!: (files: unknown[]) => void
    state.waitFiles = new Promise((resolve) => {
      finish = resolve
    })
    const pending = agent.submit({ requestId: 'waiting', threadId: thread.id, text: 'Keep me', fileIds: ['f'], draft: { scope, version: draft.version } })
    await Promise.resolve()
    expect(agent.isRunning(thread.id)).toBe(true)
    await expect(agent.send_(thread.id, 'race')).rejects.toThrow()
    agent.stop(thread.id)
    finish([])
    await expect(pending).rejects.toThrow('cancelled')
    expect(drafts.get(scope).text).toBe('Keep me')
    expect(agent.isRunning(thread.id)).toBe(false)
    expect(state.runs).toHaveLength(0)
  })
  it('does not create a thread or clear a draft when preparation fails', async () => {
    const scope = { surface: 'main' as const }
    const draft = drafts.save({ scope, text: 'Keep', fileIds: [], projectFiles: [], modelId: null, expectedVersion: 0 })
    state.enabled = false
    await expect(agent.submit({ requestId: 'fail', text: 'Keep', draft: { scope, version: draft.version } })).rejects.toThrow('disabled')
    expect(agent.listThreads()).toEqual([])
    expect(drafts.get(scope).text).toBe('Keep')
  })
  it('clears only the accepted draft version and preserves edits made during preparation', async () => {
    const thread = agent.createThread()
    const scope = { surface: 'main' as const, threadId: thread.id }
    const draft = drafts.save({ scope, text: 'Old', fileIds: ['f'], projectFiles: [], modelId: null, expectedVersion: 0 })
    let finish!: (files: unknown[]) => void
    state.waitFiles = new Promise((resolve) => {
      finish = resolve
    })
    const pending = agent.submit({ requestId: 'old', threadId: thread.id, text: 'Old', fileIds: ['f'], draft: { scope, version: draft.version } })
    drafts.save({ ...draft, text: 'New', expectedVersion: draft.version })
    finish([])
    await pending
    expect(drafts.get(scope).text).toBe('New')
    await drain()
  })
  it('retry preflight refuses checkpointed messages and active threads', async () => {
    const receipt = await agent.submit({ requestId: 'retry-check', text: 'Hello' })
    await expect(agent.assertRetryableSubmission(receipt.threadId, receipt.messageId)).rejects.toThrow()
    await drain()
    state.checkpoint.messages = [{ id: receipt.messageId, role: 'user', content: 'Hello' }]
    await expect(agent.assertRetryableSubmission(receipt.threadId, receipt.messageId)).rejects.toThrow('already checkpointed')
    await expect(agent.retrySubmission(receipt.threadId, receipt.messageId)).rejects.toThrow('already checkpointed')
    expect(state.runs).toHaveLength(1)
  })

  it('retains execution identity through approval and rejects decisions after cancellation', async () => {
    const thread = agent.createThread()
    const events: ExecutionEvent[] = []
    agent.subscribeExecution((event) => events.push(event))
    state.result = { finalText: '', interrupted: true }
    state.checkpoint.interrupt = { id: 'approval', actionRequests: [{ name: 'write', args: {} }], allowedDecisions: [['approve']] }
    await agent.send_(thread.id, 'Go', [], { executionId: 'task-execution' })
    expect((await agent.approvalSummaries())[0]).toMatchObject({ executionId: 'task-execution' })
    await expect(agent.resume(thread.id, [{ type: 'approve' }], [], 'old')).rejects.toThrow('no longer pending')
    state.result = { finalText: '', interrupted: false }
    state.checkpoint.interrupt = null
    await agent.resume(thread.id, [{ type: 'approve' }], [], 'approval')
    expect(events.map((event) => event.phase)).toEqual(['running', 'waiting_approval', 'running', 'success'])
    expect(new Set(events.map((event) => event.executionId))).toEqual(new Set(['task-execution']))
    submissions.setExecution(thread.id, 'another', 'waiting_approval')
    agent.stop(thread.id)
    await expect(agent.assertPendingApproval(thread.id)).rejects.toThrow('no longer pending')
    await expect(agent.resume(thread.id, [{ type: 'approve' }])).rejects.toThrow('no longer pending')
    expect((await agent.threadState(thread.id)).interrupt).toBeNull()
  })
})
