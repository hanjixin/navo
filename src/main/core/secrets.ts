import { safeStorage } from 'electron'
import { db } from './db'

/** Secrets are encrypted with the OS keychain via safeStorage and never leave the main process. */
export const secrets = {
  set(key: string, value: string): void {
    const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : `plain:${Buffer.from(value).toString('base64')}`
    db().prepare('INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, enc)
  },
  get(key: string): string | null {
    const row = db().prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    if (row.value.startsWith('plain:')) return Buffer.from(row.value.slice(6), 'base64').toString()
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
  },
  has(key: string): boolean {
    return !!db().prepare('SELECT 1 FROM secrets WHERE key = ?').get(key)
  },
  delete(key: string): void {
    db().prepare('DELETE FROM secrets WHERE key = ?').run(key)
  },
}
