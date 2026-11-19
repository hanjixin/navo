import { describe, expect, it } from 'vitest'

// better-sqlite3 is compiled for Electron's ABI, so plain Node can't load it: validate the migration list statically
describe('database migrations', async () => {
  const src = (await import('node:fs')).readFileSync('src/main/core/db-core.ts', 'utf8')
  it('has no holes (",,") that would run `undefined` as SQL', () => {
    const block = src.slice(src.indexOf('const MIGRATIONS'), src.indexOf('\n]\n'))
    expect(block).not.toMatch(/`\s*,\s*,/)
    const entries = block.match(/`[\s\S]*?`/g) ?? []
    expect(entries.length).toBeGreaterThanOrEqual(2)
    for (const e of entries) expect(e).toMatch(/CREATE TABLE|ALTER TABLE/)
  })

  it('repairs partially applied output metadata migrations on startup', () => {
    expect(src).toContain('PRAGMA table_info(outputs)')
    for (const column of ['workspace_root', 'run_id', 'execution_id', 'message_id', 'content_hash', 'name', 'kind']) expect(src).toContain(`['${column}',`)
    expect(src).toContain('CREATE INDEX IF NOT EXISTS outputs_execution')
  })
})
