import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync, truncateSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const state = vi.hoisted(() => ({ db: null as unknown as DatabaseSync, workspace: '', show: vi.fn(), open: vi.fn(async () => '') }))
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
vi.mock('../src/main/files/file-service', () => ({ files: { markdownOf: vi.fn(), addData: vi.fn((name, data) => ({ id: name + ':' + data.toString() })) } }))
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, shell: { showItemInFolder: state.show, openPath: state.open } }))
import { projects } from '../src/main/projects/project-service'
import { projectFiles } from '../src/main/projects/project-files'
const dirs: string[] = []
const dir = () => {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'navo-files-')))
  dirs.push(p)
  return p
}
let id: string
beforeEach(() => {
  state.workspace = dir()
  state.db = new DatabaseSync(':memory:')
  state.db.exec('PRAGMA foreign_keys=ON')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const m of source.matchAll(/`([\s\S]*?)`/g)) state.db.exec(m[1])
  id = projects.save({ name: 'Files' }).id
})
afterEach(() => {
  state.db.close()
  for (const p of dirs.splice(0)) {
    chmodSync(p, 0o700)
    rmSync(p, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

describe('project file browsing', () => {
  it('lists one level, sorts directories first, and supports hidden and nested paths', () => {
    mkdirSync(join(state.workspace, 'z-dir'))
    writeFileSync(join(state.workspace, 'a.txt'), 'A')
    writeFileSync(join(state.workspace, '.hidden'), 'H')
    writeFileSync(join(state.workspace, 'z-dir', 'nested.tsx'), 'export const a = 1')
    const root = projectFiles.list(id)
    expect(root).toMatchObject({ root: state.workspace, path: '', truncated: false })
    expect(root.entries.map((e) => e.name)).toEqual(['z-dir', 'a.txt'])
    expect(projectFiles.list(id, '', true).entries.map((e) => e.name)).toContain('.hidden')
    expect(projectFiles.list(id, 'z-dir').entries[0]).toMatchObject({ name: 'nested.tsx', path: 'z-dir/nested.tsx', kind: 'file' })
  })
  it('paginates all 501 entries and rejects a cursor when directory membership changes', async () => {
    for (let i = 0; i < 501; i++) writeFileSync(join(state.workspace, `${i}.txt`), '')
    let page = await projectFiles.listPage(id)
    const firstCursor = page.nextCursor!
    const names = page.entries.map((entry) => entry.name)
    while (page.nextCursor) {
      page = await projectFiles.listPage(id, '', false, page.nextCursor)
      names.push(...page.entries.map((entry) => entry.name))
    }
    expect(new Set(names).size).toBe(501)
    writeFileSync(join(state.workspace, 'new.txt'), '')
    await expect(projectFiles.listPage(id, '', false, firstCursor)).rejects.toThrow()
  })
  it('searches paths, excludes dependency folders and supports cancellation', async () => {
    mkdirSync(join(state.workspace, 'src'))
    mkdirSync(join(state.workspace, 'node_modules'))
    writeFileSync(join(state.workspace, 'src', 'match.ts'), 'ok')
    writeFileSync(join(state.workspace, 'node_modules', 'match.ts'), 'skip')
    expect((await projectFiles.search(id, 'match', 'request')).entries.map((entry) => entry.path)).toEqual(['src/match.ts'])
    const pending = projectFiles.search(id, 'match', 'cancel')
    projectFiles.cancelSearch('cancel')
    expect((await pending).cancelled).toBe(true)
  })
  it('captures latest source bytes and rejects a changed project or root', async () => {
    const ref = { projectId: id, root: state.workspace, path: 'latest.txt' }
    writeFileSync(join(state.workspace, ref.path), 'old')
    writeFileSync(join(state.workspace, ref.path), 'latest')
    expect((await projectFiles.captureReferences([ref], id)).fileIds).toEqual(['latest.txt:latest'])
    await expect(projectFiles.captureReferences([ref], 'other')).rejects.toThrow()
    projects.save({ id, name: 'Files', workingDirectory: dir() })
    await expect(projectFiles.captureReferences([ref], id)).rejects.toThrow()
  })
  it('caps at 500 entries and explicitly reports truncation', () => {
    for (let i = 0; i < 501; i++) writeFileSync(join(state.workspace, `${i}.txt`), '')
    expect(projectFiles.list(id)).toMatchObject({ truncated: true })
    expect(projectFiles.list(id).entries).toHaveLength(500)
  })
  it('rejects absolute paths, traversal and NUL; skips symlinks and FIFO without opening them', async () => {
    const outside = dir()
    writeFileSync(join(outside, 'outside.txt'), 'outside')
    symlinkSync(outside, join(state.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    if (process.platform !== 'win32') execFileSync('mkfifo', [join(state.workspace, 'pipe')])
    expect(projectFiles.list(id).entries).toEqual([])
    for (const path of ['/tmp', '../outside', 'a/../outside', 'bad\0name', 'C:\\Windows']) expect(() => projectFiles.list(id, path)).toThrow()
    await expect(projectFiles.preview(id, 'link/outside.txt')).rejects.toThrow()
    if (process.platform !== 'win32') await expect(projectFiles.preview(id, 'pipe')).rejects.toThrow()
    expect(() => projectFiles.reveal(id, 'link')).toThrow()
  })
  it('tracks the current root, resets to default, and reports deleted projects or missing roots', () => {
    const selected = dir()
    writeFileSync(join(selected, 'selected.txt'), 'S')
    writeFileSync(join(state.workspace, 'default.txt'), 'D')
    projects.save({ id, name: 'Files', workingDirectory: selected })
    expect(projectFiles.list(id).entries[0].name).toBe('selected.txt')
    projects.save({ id, name: 'Files', workingDirectory: null })
    expect(projectFiles.list(id).entries[0].name).toBe('default.txt')
    projects.save({ id, name: 'Files', workingDirectory: selected })
    rmSync(selected, { recursive: true })
    dirs.splice(dirs.indexOf(selected), 1)
    expect(() => projectFiles.list(id)).toThrow()
    projects.delete(id)
    expect(() => projectFiles.list(id)).toThrow('项目不存在')
  })
  it('reads a directory without write permission and opens/reveals only inside the selected root', async () => {
    writeFileSync(join(state.workspace, 'read.txt'), 'read')
    chmodSync(state.workspace, 0o500)
    expect(projectFiles.list(id).entries[0].name).toBe('read.txt')
    await projectFiles.openDirectory(id)
    projectFiles.reveal(id, 'read.txt')
    expect(state.open).toHaveBeenCalledWith(state.workspace)
    expect(state.show).toHaveBeenCalledWith(join(state.workspace, 'read.txt'))
  })
  it('previews code and text without registering files or outputs, with binary and size limits', async () => {
    writeFileSync(join(state.workspace, 'component.tsx'), 'const Component = () => <main />')
    writeFileSync(join(state.workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]))
    expect(await projectFiles.preview(id, 'component.tsx')).toMatchObject({ kind: 'text', text: 'const Component = () => <main />' })
    expect(await projectFiles.preview(id, 'binary.bin')).toMatchObject({ kind: 'other' })
    for (const [name, size] of [
      ['large.txt', 2 * 1024 * 1024 + 1],
      ['large.pdf', 20 * 1024 * 1024 + 1],
      ['large.png', 15 * 1024 * 1024 + 1],
    ] as const) {
      writeFileSync(join(state.workspace, name), '')
      truncateSync(join(state.workspace, name), size)
      expect(await projectFiles.preview(id, name)).toMatchObject({ kind: 'other' })
    }
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM outputs').get()?.n).toBe(0)
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM files').get()?.n).toBe(0)
  })
})
