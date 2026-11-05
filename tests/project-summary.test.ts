import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }))
vi.mock('../src/main/core/db', () => ({ db: () => state.db }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
import { projects } from '../src/main/projects/project-service'

beforeEach(() => {
  state.db = new DatabaseSync(':memory:')
  state.db.exec('PRAGMA foreign_keys=ON')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const match of source.matchAll(/`([\s\S]*?)`/g)) state.db.exec(match[1])
})
afterEach(() => {
  state.db.close()
  vi.restoreAllMocks()
})

describe('project summaries and details', () => {
  it('computes counts without multiplying artifacts by threads and excludes hidden conversations', () => {
    const p = projects.save({ name: 'Project' })
    state.db.prepare('INSERT INTO threads(id,title,created_at,updated_at,project_id,hidden) VALUES(?,?,?,?,?,?)').run('a', 'A', 1, 10, p.id, 0)
    state.db.prepare('INSERT INTO threads(id,title,created_at,updated_at,project_id,hidden) VALUES(?,?,?,?,?,?)').run('b', 'B', 1, 20, p.id, 0)
    state.db.prepare('INSERT INTO threads(id,title,created_at,updated_at,project_id,hidden) VALUES(?,?,?,?,?,?)').run('hidden', 'Hidden', 1, 30, p.id, 1)
    for (const id of ['one', 'two'])
      state.db
        .prepare('INSERT INTO outputs(id,thread_id,path,source,size,at) VALUES(?,?,?,?,?,?)')
        .run(id, 'a', `/workspace/${id}.txt`, 'agent', 5, Date.now() + 5000)
    const detail = projects.get(p.id)!
    expect(detail.threadCount).toBe(2)
    expect(detail.artifactCount).toBe(2)
    expect(detail.lastActivityAt).toBeGreaterThan(p.updatedAt)
    expect(detail.threads.map((t) => t.id)).toEqual(['b', 'a'])
    expect(projects.get('missing')).toBeNull()
  })
  it('moves aggregation with conversation ownership and preserves outputs after deleting the project', () => {
    const a = projects.save({ name: 'A' }),
      b = projects.save({ name: 'B' })
    state.db.prepare('INSERT INTO threads(id,title,created_at,updated_at,project_id) VALUES(?,?,?,?,?)').run('thread', 'T', 1, 2, a.id)
    state.db.prepare('INSERT INTO outputs(id,thread_id,path,source,size,at) VALUES(?,?,?,?,?,?)').run('out', 'thread', '/workspace/file.txt', 'agent', 2, 3)
    expect(projects.get(a.id)?.artifactCount).toBe(1)
    state.db.prepare('UPDATE threads SET project_id=? WHERE id=?').run(b.id, 'thread')
    expect(projects.get(a.id)?.artifactCount).toBe(0)
    expect(projects.get(b.id)?.artifactCount).toBe(1)
    projects.delete(b.id)
    expect(state.db.prepare('SELECT project_id FROM threads WHERE id=?').get('thread')?.project_id).toBeNull()
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM outputs').get()?.n).toBe(1)
  })
})

describe('project upgrade and editing', () => {
  it('upgrades an existing schema without altering its conversations or outputs', () => {
    state.db.close()
    state.db = new DatabaseSync(':memory:')
    state.db.exec('PRAGMA foreign_keys=ON')
    const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
    const migrations = Array.from(source.matchAll(/`([\s\S]*?)`/g), (m) => m[1])
    const projectIndex = migrations.findIndex((sql) => sql.includes('CREATE TABLE projects'))
    expect(projectIndex).toBeGreaterThan(0)
    for (const sql of migrations.slice(0, projectIndex)) state.db.exec(sql)
    state.db.prepare('INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,?,?)').run('old', 'Existing conversation', 10, 20)
    state.db
      .prepare('INSERT INTO outputs(id,thread_id,path,source,size,at) VALUES(?,?,?,?,?,?)')
      .run('old-output', 'old', '/workspace/existing.txt', 'agent', 42, 30)
    const before = state.db.prepare('SELECT * FROM outputs').all()
    for (const sql of migrations.slice(projectIndex)) state.db.exec(sql)
    const thread = state.db.prepare('SELECT * FROM threads WHERE id=?').get('old')!
    expect(thread).toMatchObject({ id: 'old', title: 'Existing conversation', created_at: 10, updated_at: 20, project_id: null })
    expect(state.db.prepare('SELECT * FROM outputs').all()).toEqual(before.map((row) => ({ ...row, workspace_root: null, name: '', kind: 'other' })))
    expect(projects.list()).toEqual([])
  })
  it('edits while retaining createdAt, trims values, and rejects blank or invalid inputs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const created = projects.save({ name: '  First  ', description: '  Context  ' })
    vi.mocked(Date.now).mockReturnValue(200)
    const edited = projects.save({ id: created.id, name: '  Edited  ', description: '  New context  ' })
    expect(edited).toMatchObject({ name: 'Edited', description: 'New context', createdAt: 100, updatedAt: 200 })
    expect(() => projects.save({ name: '   ' })).toThrow()
    expect(() => projects.save({ name: 42 } as never)).toThrow('项目名称必须是文本')
    expect(() => projects.save({ name: 'Valid', description: 42 } as never)).toThrow('项目描述必须是文本')
    expect(projects.get(created.id)?.name).toBe('Edited')
  })
})

it('retrieves and edits an individual project without loading every project summary', () => {
  const a = projects.save({ name: 'Selected' })
  projects.save({ name: 'Other' })
  vi.spyOn(projects, 'list').mockImplementation(() => {
    throw new Error('Bulk listing must not be needed')
  })
  expect(projects.get(a.id)?.name).toBe('Selected')
  expect(projects.basic(a.id)?.name).toBe('Selected')
  expect(projects.basic('absent')).toBeNull()
  expect(projects.save({ id: a.id, name: 'Edited' }).name).toBe('Edited')
})
