import type { TraceEntry } from '@shared/types'
import { db } from '../core/db'

export const traces = {
  list(threadId?: string): TraceEntry[] {
    const rows = (
      threadId
        ? db().prepare('SELECT * FROM traces WHERE thread_id = ? ORDER BY created_at DESC LIMIT 500').all(threadId)
        : db().prepare('SELECT * FROM traces ORDER BY created_at DESC LIMIT 500').all()
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      runId: r.run_id as string,
      kind: r.kind as TraceEntry['kind'],
      name: r.name as string,
      input: r.input as string,
      output: r.output as string,
      durationMs: r.duration_ms as number,
      tokens: r.tokens as number | null,
      createdAt: r.created_at as number,
    }))
  },
  clear(): void {
    db().prepare('DELETE FROM traces').run()
  },
}
