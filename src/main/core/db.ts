import type Database from 'better-sqlite3'
import { paths } from './paths'
import { openDatabase } from './db-core'

let instance: Database.Database | null = null

export function db(): Database.Database {
  instance ??= openDatabase(paths.db)
  return instance
}

export const kv = {
  get<T>(key: string, fallback: T): T {
    const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : fallback
  },
  set(key: string, value: unknown): void {
    db().prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  },
}

export const json = {
  parse<T>(s: string | null | undefined): T | null {
    if (!s) return null
    try {
      return JSON.parse(s) as T
    } catch {
      return null
    }
  },
  str(v: unknown): string | null {
    return v == null ? null : JSON.stringify(v)
  },
}
