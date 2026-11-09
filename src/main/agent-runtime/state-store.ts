import type Database from 'better-sqlite3'

/** Durable per-thread runtime state. Engines store opaque session data here. */
export interface RuntimeStateStore<T> {
  read(threadId: string): T | null
  write(threadId: string, state: T): void
  remove(threadId: string): void
  list?(): string[]
}

/** SQLite kv implementation for adapters that do not need a custom schema. */
export class KvRuntimeStateStore<T> implements RuntimeStateStore<T> {
  constructor(
    private readonly database: Database.Database,
    private readonly namespace: string,
    private readonly fallback?: (threadId: string) => T | null,
  ) {}

  private key(threadId: string): string {
    return `${this.namespace}:${threadId}`
  }

  read(threadId: string): T | null {
    const row = this.database.prepare('SELECT value FROM kv WHERE key=?').get(this.key(threadId)) as { value: string } | undefined
    if (row) return JSON.parse(row.value) as T
    return this.fallback?.(threadId) ?? null
  }

  write(threadId: string, state: T): void {
    this.database.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(this.key(threadId), JSON.stringify(state))
  }

  remove(threadId: string): void {
    this.database.prepare('DELETE FROM kv WHERE key=?').run(this.key(threadId))
  }
}
