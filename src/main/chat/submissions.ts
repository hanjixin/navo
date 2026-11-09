import type Database from 'better-sqlite3'
import type { ChatSubmitInput, ChatSubmitReceipt, ExecutionPhase, ApprovalSummary } from '@shared/reliability'
import type { UIMessage, PendingInterrupt } from '@shared/types'
import type { RunRequest } from '../agent-runtime/contracts'
import { db } from '../core/db'

export function submissionPayload(input: ChatSubmitInput): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)]),
      )
    return value
  }
  return JSON.stringify(stable(input))
}

export class SubmissionStore {
  constructor(private database: () => Database.Database = db) {}

  find(requestId: string, payload: string): ChatSubmitReceipt | null {
    const row = this.database().prepare('SELECT * FROM chat_submissions WHERE request_id = ?').get(requestId) as
      { payload: string; thread_id: string; message_id: string; execution_id: string } | undefined
    if (!row) return null
    if (row.payload !== payload) throw new Error('Submission ID already used with different content')
    return { requestId, threadId: row.thread_id, messageId: row.message_id, executionId: row.execution_id }
  }

  accept(receipt: ChatSubmitReceipt, payload: string, message: UIMessage, input: RunRequest['input']): void {
    this.database()
      .prepare(
        `INSERT INTO chat_submissions(request_id,payload,thread_id,message_id,execution_id,message,input,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(receipt.requestId, payload, receipt.threadId, receipt.messageId, receipt.executionId, JSON.stringify(message), JSON.stringify(input), Date.now())
  }

  merge(threadId: string, messages: UIMessage[]): UIMessage[] {
    const seen = new Set(messages.map((m) => m.id))
    const rows = this.database()
      .prepare('SELECT message_id, message FROM chat_submissions WHERE thread_id = ? AND checkpointed = 0 AND superseded = 0 ORDER BY created_at, rowid')
      .all(threadId) as { message_id: string; message: string }[]
    const mark = this.database().prepare('UPDATE chat_submissions SET checkpointed = 1 WHERE message_id = ?')
    const result = [...messages]
    for (const row of rows) {
      if (seen.has(row.message_id)) mark.run(row.message_id)
      else result.push(JSON.parse(row.message) as UIMessage)
    }
    return result
  }

  /** An explicit history fork abandons accepted but uncheckpointed messages on the old branch. Receipts remain idempotent. */
  supersedePending(threadId: string): void {
    this.database().prepare('UPDATE chat_submissions SET superseded=1 WHERE thread_id=? AND checkpointed=0').run(threadId)
  }

  recoverable(threadId: string): string[] {
    return (
      this.database()
        .prepare('SELECT message_id FROM chat_submissions WHERE thread_id=? AND checkpointed=0 AND superseded=0 ORDER BY created_at,rowid')
        .all(threadId) as {
        message_id: string
      }[]
    ).map((r) => r.message_id)
  }

  pendingInput(threadId: string, messageId: string): { input: RunRequest['input']; executionId: string } | null {
    const row = this.database()
      .prepare('SELECT input, execution_id FROM chat_submissions WHERE thread_id = ? AND message_id = ? AND checkpointed = 0 AND superseded = 0')
      .get(threadId, messageId) as { input: string; execution_id: string } | undefined
    return row ? { input: JSON.parse(row.input), executionId: row.execution_id } : null
  }

  execution(threadId: string): { id: string; phase: ExecutionPhase } | null {
    return (
      (this.database().prepare('SELECT id,phase FROM agent_executions WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(threadId) as
        { id: string; phase: ExecutionPhase } | undefined) ?? null
    )
  }

  setExecution(threadId: string, id: string, phase: ExecutionPhase): void {
    this.database()
      .prepare(
        `INSERT INTO agent_executions(id,thread_id,phase,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,updated_at=excluded.updated_at`,
      )
      .run(id, threadId, phase, Date.now())
    if (phase !== 'waiting_approval') this.database().prepare('DELETE FROM approval_summaries WHERE thread_id = ?').run(threadId)
  }

  interrupt(threadId: string, executionId: string, interrupt: PendingInterrupt): void {
    this.database()
      .prepare(
        `INSERT INTO approval_summaries(thread_id,execution_id,interrupt,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET execution_id=excluded.execution_id,interrupt=excluded.interrupt,updated_at=excluded.updated_at`,
      )
      .run(threadId, executionId, JSON.stringify(interrupt), Date.now())
  }

  approvals(): ApprovalSummary[] {
    const rows = this.database()
      .prepare(
        `SELECT a.*, t.title, t.project_id FROM approval_summaries a JOIN threads t ON t.id=a.thread_id
      JOIN agent_executions e ON e.id=a.execution_id WHERE e.phase='waiting_approval' ORDER BY a.updated_at DESC`,
      )
      .all() as { thread_id: string; execution_id: string; interrupt: string; updated_at: number; title: string; project_id: string | null }[]
    return rows.map((r) => ({
      threadId: r.thread_id,
      executionId: r.execution_id,
      interrupt: JSON.parse(r.interrupt),
      updatedAt: r.updated_at,
      threadTitle: r.title,
      projectId: r.project_id,
    }))
  }

  recoverInterrupted(): void {
    this.database().prepare("UPDATE agent_executions SET phase='error', updated_at=? WHERE phase='running'").run(Date.now())
  }
}

export const submissions = new SubmissionStore()
