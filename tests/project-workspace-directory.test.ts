import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync, chmodSync, truncateSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveRunWorkspaceRoot, validateWorkingDirectory } from '../src/main/projects/workspace-directory'
import { outputAbsolutePath, workspaceFile } from '../src/main/outputs/workspace-paths'

const state = vi.hoisted(() => ({ db: null as unknown as DatabaseSync, workspace: '' }))
vi.mock('../src/main/core/db', () => ({ db: () => state.db }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/paths', () => ({
  paths: {
    get workspace() {
      return state.workspace
    },
  },
}))
vi.mock('../src/main/core/logger', () => ({ log: { info: vi.fn() } }))
vi.mock('../src/main/files/file-service', () => ({ files: {} }))
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, shell: {} }))
import { projects } from '../src/main/projects/project-service'
import { outputs } from '../src/main/outputs/outputs-service'
const dirs: string[] = []
const dir = () => {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'navo-project-root-')))
  dirs.push(p)
  return p
}
beforeEach(() => {
  state.workspace = dir()
  state.db = new DatabaseSync(':memory:')
  state.db.exec('PRAGMA foreign_keys=ON')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const m of source.matchAll(/`([\s\S]*?)`/g)) state.db.exec(m[1])
  state.db.prepare('INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,?,?)').run('thread', 'Thread', 1, 1)
})
afterEach(() => {
  vi.restoreAllMocks()
  state.db.close()
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true })
})

describe('project workspace directories', () => {
  it('defaults to null, preserves omitted directory edits, and supports resetting to default', () => {
    const root = dir()
    const project = projects.save({ name: 'Default' })
    expect(project.workingDirectory).toBeNull()
    expect(projects.save({ id: project.id, name: 'Bound', workingDirectory: root }).workingDirectory).toBe(root)
    expect(projects.save({ id: project.id, name: 'Renamed' }).workingDirectory).toBe(root)
    expect(projects.save({ id: project.id, name: 'Reset', workingDirectory: null }).workingDirectory).toBeNull()
  })
  it('rejects relative paths, files, and a selected directory that disappears before running', () => {
    const root = dir()
    writeFileSync(join(root, 'file.txt'), 'file')
    expect(() => validateWorkingDirectory('relative')).toThrow()
    expect(() => validateWorkingDirectory(join(root, 'file.txt'))).toThrow()
    projects.save({ name: 'Gone', workingDirectory: root })
    rmSync(root, { recursive: true })
    expect(() => validateWorkingDirectory(root)).toThrow()
  })
  it('stores distinct same-name files from different roots and previews historical files after changing roots', async () => {
    const a = dir(),
      b = dir()
    writeFileSync(join(a, 'same.txt'), 'A')
    writeFileSync(join(b, 'same.txt'), 'B')
    const p = projects.save({ name: 'Project', workingDirectory: a })
    outputs.recordWorkspaceWrite('thread', '/same.txt', a)
    projects.save({ id: p.id, name: p.name, workingDirectory: b })
    outputs.recordWorkspaceWrite('thread', '/same.txt', b)
    const files = outputs.list('thread')
    expect(files).toHaveLength(2)
    expect(await outputs.preview(files.find((f) => f.path === join(a, 'same.txt'))!.id)).toMatchObject({ text: 'A' })
    expect(await outputs.preview(files.find((f) => f.path === join(b, 'same.txt'))!.id)).toMatchObject({ text: 'B' })
    expect(state.db.prepare('SELECT DISTINCT workspace_root FROM outputs').all()).toHaveLength(2)
  })
  it('keeps default and legacy virtual paths readable', async () => {
    writeFileSync(join(state.workspace, 'legacy.txt'), 'legacy')
    writeFileSync(join(state.workspace, 'new.txt'), 'new')
    state.db
      .prepare('INSERT INTO outputs(id,thread_id,path,source,size,at) VALUES(?,?,?,?,?,?)')
      .run('legacy', 'thread', '/workspace/legacy.txt', 'agent', 6, 1)
    outputs.recordWorkspaceWrite('thread', '/new.txt')
    expect(outputs.list('thread').map((f) => f.path)).toContain('/workspace/new.txt')
    expect(await outputs.preview('legacy')).toMatchObject({ text: 'legacy' })
  })
  it('rejects traversal and symlink escapes before recording', () => {
    const root = dir(),
      outside = dir()
    writeFileSync(join(outside, 'file.txt'), 'outside')
    symlinkSync(outside, join(root, 'escape'))
    expect(() => workspaceFile(root, '../outside')).toThrow()
    expect(() => outputs.recordWorkspaceWrite('thread', '/escape/file.txt', root)).toThrow()
    expect(outputs.list('thread')).toEqual([])
  })
})

it('does not reinterpret a custom absolute /workspace path as a virtual default path', () => {
  expect(outputAbsolutePath({ path: '/workspace/report.txt', workspace_root: '/workspace' }, '/default')).toBe('/workspace/report.txt')
  expect(outputAbsolutePath({ path: '/workspace/report.txt', workspace_root: null }, '/default')).toBe('/default/report.txt')
})

it('exports with the run snapshot and keeps UI exports tied to the recorded root', async () => {
  const a = dir(),
    b = dir()
  writeFileSync(join(a, 'report.md'), 'A')
  writeFileSync(join(b, 'report.md'), 'B')
  const project = projects.save({ name: 'Export', workingDirectory: a })
  const snapshot = project.workingDirectory!
  projects.save({ id: project.id, name: project.name, workingDirectory: b })
  vi.spyOn(outputs, 'convert').mockResolvedValue({ data: Buffer.from('converted A'), name: 'report.docx' })
  expect(await outputs.exportWorkspaceFile('thread', '/workspace/report.md', 'docx', snapshot)).toBe('/workspace/report.docx')
  expect(readFileSync(join(a, 'report.docx'), 'utf8')).toBe('converted A')
  const original = outputs.list('thread').find((f) => f.path === join(a, 'report.md'))!
  await outputs.export(original.id, 'docx', join(b, 'elsewhere.docx'))
  expect(outputs.list('thread').map((f) => f.path)).not.toContain(join(b, 'elsewhere.docx'))
  await outputs.export(original.id, 'docx', 'beside')
  expect(outputs.list('thread').find((f) => f.path === join(a, 'report.docx'))).toBeDefined()
})

it('resumes from the persisted interrupted root and rejects missing or deleted snapshots', () => {
  const a = dir(),
    b = dir()
  const persisted = resolveRunWorkspaceRoot('message', a, state.workspace, null)
  expect(resolveRunWorkspaceRoot('resume', b, state.workspace, persisted)).toBe(a)
  expect(resolveRunWorkspaceRoot('message', b, state.workspace, persisted)).toBe(b)
  expect(() => resolveRunWorkspaceRoot('resume', b, state.workspace, null)).toThrow()
  rmSync(a, { recursive: true })
  expect(() => resolveRunWorkspaceRoot('resume', b, state.workspace, persisted)).toThrow()
})

describe('artifact file availability', () => {
  it('keeps healthy files visible when neighbors disappear or become unreadable', () => {
    for (const name of ['healthy.txt', 'gone.txt', 'blocked.txt', 'directory.txt']) {
      writeFileSync(join(state.workspace, name), 'hello')
      outputs.recordWorkspaceWrite('thread', `/${name}`)
    }
    rmSync(join(state.workspace, 'gone.txt'))
    rmSync(join(state.workspace, 'directory.txt'))
    mkdirSync(join(state.workspace, 'directory.txt'))
    chmodSync(join(state.workspace, 'blocked.txt'), 0)
    try {
      const result = outputs.artifacts()
      expect(result).toHaveLength(4)
      expect(result.find((f) => f.name === 'healthy.txt')).toMatchObject({ missing: false, size: 5 })
      expect(result.find((f) => f.name === 'gone.txt')).toMatchObject({ missing: true, unavailableReason: 'missing', exports: [] })
      expect(result.find((f) => f.name === 'directory.txt')).toMatchObject({ missing: false, unavailableReason: 'unreadable', exports: [] })
      // Root can read chmod(000) files; ordinary desktop users cannot.
      if (process.getuid?.() !== 0)
        expect(result.find((f) => f.name === 'blocked.txt')).toMatchObject({ missing: false, unavailableReason: 'unreadable', exports: [] })
      expect(outputs.list('thread')).toHaveLength(4)
    } finally {
      chmodSync(join(state.workspace, 'blocked.txt'), 0o600)
    }
  })
  it('uses current size and avoids reading externally enlarged text files', () => {
    const path = join(state.workspace, 'large.json')
    writeFileSync(path, '[{"a":1}]')
    outputs.recordWorkspaceWrite('thread', '/large.json')
    truncateSync(path, 32 * 1024 * 1024)
    const file = outputs.list('thread')[0]
    expect(file.size).toBe(32 * 1024 * 1024)
    expect(file.missing).toBe(false)
    expect(file.exports).not.toContain('xlsx')
  })
})
