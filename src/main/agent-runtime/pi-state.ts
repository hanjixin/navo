import type Database from 'better-sqlite3'
import type { PiSnapshot } from '../pi-host/runner'
import type { UIMessage } from '@shared/types'
import type { RuntimeStateStore } from './state-store'

/** SQLite-backed Pi checkpoints; imported CLI history remains readable without launching a CLI. */
export class PiStateStore implements RuntimeStateStore<PiSnapshot> {
  constructor(private readonly database: Database.Database) {}
  private key(threadId: string): string {
    return `pi.state:${threadId}`
  }
  read(threadId: string): PiSnapshot | null {
    const row = this.database.prepare('SELECT value FROM kv WHERE key=?').get(this.key(threadId)) as { value: string } | undefined
    if (row) return JSON.parse(row.value)
    const legacy = this.database.prepare('SELECT value FROM kv WHERE key=?').get(`runtime.session:${threadId}`) as { value: string } | undefined
    if (!legacy) return null
    const value = JSON.parse(legacy.value) as { kind: string; messages: UIMessage[] }
    if (value.kind !== 'pi') return null
    const ui = value.messages ?? []
    const messages = ui
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: 'user' as const, content: `${m.role}: ${m.content}`, timestamp: Date.now() }))
    return { messages, ui, pending: null, inFlight: null }
  }
  write(threadId: string, state: PiSnapshot): void {
    if (!this.database.prepare('SELECT 1 FROM threads WHERE id=?').get(threadId)) return
    this.database.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(this.key(threadId), JSON.stringify(state))
  }
  remove(threadId: string): void {
    this.database.prepare('DELETE FROM kv WHERE key IN (?,?)').run(this.key(threadId), `runtime.session:${threadId}`)
  }
  list(): string[] {
    return (this.database.prepare("SELECT id FROM threads WHERE runtime_id='pi'").all() as { id: string }[]).map((r) => r.id)
  }
}
