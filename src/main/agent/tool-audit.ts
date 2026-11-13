import type Database from 'better-sqlite3'
import type { ToolSource } from '../agent-runtime/contracts'
import type { ToolAuditEntry as SharedToolAuditEntry } from '@shared/types'
import { newId } from '../core/id'

export type ToolAuditStatus = 'started' | 'success' | 'error' | 'cancelled'

export type ToolAuditEntry = SharedToolAuditEntry

export function startToolAudit(database: Database.Database, input: Omit<ToolAuditEntry, 'id' | 'status' | 'error' | 'finishedAt'>): string {
  const id = newId()
  database
    .prepare(
      `INSERT INTO tool_audits(id, thread_id, project_id, run_id, execution_id, runtime_id, tool_name, source, status, started_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, input.threadId, input.projectId, input.runId, input.executionId, input.runtimeId, input.toolName, input.source, 'started', input.startedAt)
  return id
}

export function finishToolAudit(database: Database.Database, id: string, status: ToolAuditStatus, error: string | null, finishedAt = Date.now()): void {
  database.prepare('UPDATE tool_audits SET status=?, error=?, finished_at=? WHERE id=?').run(status, error, finishedAt, id)
}

export function listToolAudits(database: Database.Database, threadId?: string, limit = 100): ToolAuditEntry[] {
  const rows = (
    threadId
      ? database.prepare('SELECT * FROM tool_audits WHERE thread_id=? ORDER BY started_at DESC LIMIT ?').all(threadId, Math.max(1, Math.min(500, limit)))
      : database.prepare('SELECT * FROM tool_audits ORDER BY started_at DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)))
  ) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: String(r.id),
    threadId: String(r.thread_id),
    projectId: (r.project_id as string | null) ?? null,
    runId: String(r.run_id),
    executionId: String(r.execution_id),
    runtimeId: String(r.runtime_id),
    toolName: String(r.tool_name),
    source: r.source as ToolSource,
    status: r.status as ToolAuditStatus,
    error: (r.error as string | null) ?? null,
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  }))
}
