import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { ChatSubmitInput } from '../src/shared/reliability'

vi.mock('../src/main/core/db', () => ({
  db: () => {
    throw new Error('Use injected database')
  },
}))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
import { DraftStore } from '../src/main/chat/drafts'
import { SubmissionStore, submissionPayload } from '../src/main/chat/submissions'

let sqlite: DatabaseSync
let drafts: DraftStore
let submissions: SubmissionStore
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const m of source.matchAll(/`([\s\S]*?)`/g)) sqlite.exec(m[1])
  let count = 0
  const database = Object.assign(sqlite, {
    transaction:
      <T>(fn: () => T) =>
      () => {
        const name = `test_${++count}`
        sqlite.exec(`SAVEPOINT ${name}`)
        try {
          const result = fn()
          sqlite.exec(`RELEASE ${name}`)
          return result
        } catch (error) {
          sqlite.exec(`ROLLBACK TO ${name}`)
          sqlite.exec(`RELEASE ${name}`)
          throw error
        }
      },
  }) as unknown as Database.Database
  drafts = new DraftStore(() => database)
  submissions = new SubmissionStore(() => database)
  sqlite.prepare('INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,?,?)').run('t', 'Thread', 1, 1)
})
afterEach(() => sqlite.close())
const scope = { surface: 'main' as const, threadId: 't' }
const input = { scope, text: 'Draft', fileIds: ['f'], projectFiles: [], modelId: 'm', expectedVersion: 0 }

describe('durable isolated drafts', () => {
  it('persists runtime selection through edits, moves and clear, with builtin for legacy drafts', () => {
    expect(drafts.get(scope).runtimeId).toBe('builtin')
    const saved = drafts.save({ ...input, runtimeId: 'codex' })
    const edited = drafts.save({ ...input, text: 'Edited', expectedVersion: saved.version })
    expect(edited.runtimeId).toBe('codex')
    const target = { surface: 'quick' as const, threadId: 't' }
    const moved = drafts.move(scope, target, edited.version)
    expect(moved.draft.runtimeId).toBe('codex')
    expect(drafts.get(scope).runtimeId).toBe('codex')
    drafts.clear(target, moved.draft.version)
    expect(drafts.get(target).runtimeId).toBe('codex')
    expect(() => drafts.save({ ...input, runtimeId: 'unknown', expectedVersion: drafts.get(scope).version })).toThrow('Invalid agent runtime')
  })
  it('isolates surfaces and ownership, persists content and refuses stale writes', () => {
    const saved = drafts.save(input)
    expect(saved.version).toBe(1)
    expect(drafts.get(scope)).toEqual(saved)
    expect(drafts.get({ ...scope, surface: 'quick' }).text).toBe('')
    expect(drafts.get({ surface: 'main', projectId: 'p' }).text).toBe('')
    expect(() => drafts.save({ ...input, text: 'late' })).toThrow('changed')
    expect(drafts.clear(scope, 0)).toBe(false)
    expect(drafts.get(scope).text).toBe('Draft')
    expect(drafts.clear(scope, 1)).toBe(true)
    expect(drafts.get(scope)).toMatchObject({ text: '', fileIds: [], version: 2 })
    expect(() => drafts.save({ ...input, expectedVersion: 1 })).toThrow('changed')
  })
  it('accepts a newer revision from the same editor but never resurrects cleared drafts', () => {
    drafts.save({ ...input, editorId: 'window', editRevision: 1 })
    const updated = drafts.save({ ...input, text: 'Final keystroke', editorId: 'window', editRevision: 3 })
    expect(updated.text).toBe('Final keystroke')
    expect(drafts.save({ ...input, editorId: 'window', editRevision: 2 })).toEqual(updated)
    expect(() => drafts.save({ ...input, editorId: 'other', editRevision: 5 })).toThrow('changed')
    drafts.clear(scope, updated.version)
    expect(() => drafts.save({ ...input, editorId: 'window', editRevision: 4 })).toThrow('changed')
  })
  it('moves atomically only into an empty destination and leaves both drafts on conflict', () => {
    drafts.save(input)
    const target = { surface: 'quick' as const, threadId: 't' }
    drafts.save({ ...input, scope: target, text: 'Other' })
    expect(drafts.move(scope, target, 1).moved).toBe(false)
    expect(drafts.get(scope).text).toBe('Draft')
    expect(drafts.get(target).text).toBe('Other')
    drafts.clear(target, 1)
    expect(drafts.move(scope, target, 1)).toMatchObject({ moved: true, draft: { text: 'Draft', fileIds: ['f'], modelId: 'm' } })
    expect(drafts.get(scope).text).toBe('')
  })
})

describe('durable message acceptance and execution state', () => {
  const receipt = { requestId: 'r', threadId: 't', messageId: 'u', executionId: 'e' }
  const message = { id: 'u', role: 'user' as const, content: 'hello' }
  const runInput = { kind: 'message' as const, id: 'u', text: 'hello', images: [] }
  it('uses canonical request fingerprints and rejects conflicting reuse', () => {
    const payload = submissionPayload({ requestId: 'r', text: 'hello', threadId: 't' })
    expect(submissionPayload({ threadId: 't', text: 'hello', requestId: 'r' } as ChatSubmitInput)).toBe(payload)
    submissions.accept(receipt, payload, message, runInput)
    expect(submissions.find('r', payload)).toEqual(receipt)
    expect(() => submissions.find('r', 'other')).toThrow('different content')
  })
  it('recovers accepted messages, deduplicates checkpointed messages, and never resurrects branches', () => {
    submissions.accept(receipt, 'p', message, runInput)
    expect(submissions.merge('t', [])).toEqual([message])
    expect(submissions.recoverable('t')).toEqual(['u'])
    expect(submissions.merge('t', [message])).toEqual([message])
    expect(submissions.merge('t', [])).toEqual([])
    expect(submissions.pendingInput('t', 'u')).toBeNull()
  })
  it('does not resurrect accepted old-branch messages after explicit regeneration', () => {
    submissions.accept(receipt, 'p', message, runInput)
    expect(submissions.merge('t', [])).toEqual([message])
    submissions.supersedePending('t')
    expect(submissions.merge('t', [])).toEqual([])
    expect(submissions.recoverable('t')).toEqual([])
    expect(submissions.pendingInput('t', 'u')).toBeNull()
    expect(submissions.find('r', 'p')).toEqual(receipt)
  })
  it('indexes approvals without messages, retains waiting executions and interrupts running ones on restart', () => {
    submissions.setExecution('t', 'e', 'running')
    submissions.recoverInterrupted()
    expect(submissions.execution('t')?.phase).toBe('error')
    submissions.setExecution('t', 'e', 'waiting_approval')
    const interrupt = { id: 'approval', actionRequests: [{ name: 'write', args: {} }], allowedDecisions: [['approve' as const]] }
    submissions.interrupt('t', 'e', interrupt)
    submissions.recoverInterrupted()
    expect(submissions.approvals()).toEqual([
      { threadId: 't', threadTitle: 'Thread', projectId: null, executionId: 'e', interrupt, updatedAt: expect.any(Number) },
    ])
    submissions.setExecution('t', 'e', 'cancelled')
    expect(submissions.approvals()).toEqual([])
  })
  it('cascades deleted threads without deleting independent drafts', () => {
    submissions.accept(receipt, 'p', message, runInput)
    submissions.setExecution('t', 'e', 'running')
    drafts.save(input)
    sqlite.prepare('DELETE FROM threads WHERE id=?').run('t')
    expect(submissions.find('r', 'p')).toBeNull()
    expect(submissions.execution('t')).toBeNull()
    expect(drafts.get(scope).text).toBe('Draft')
  })
})
