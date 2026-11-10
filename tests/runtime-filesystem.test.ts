import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeFilesystem, type RuntimeFilesystemConfig } from '../src/main/agent-runtime/filesystem'
import { runtimeFileTools } from '../src/main/agent-runtime/file-tools'

const dirs: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'navo-runtime-files-'))
  dirs.push(root)
  const paths = { workspace: join(root, 'workspace'), skills: join(root, 'skills'), uploads: join(root, 'uploads') }
  const external = join(root, 'external')
  for (const dir of [...Object.values(paths), join(paths.skills, 'local'), join(external, 'enabled'), join(external, 'disabled')])
    mkdirSync(dir, { recursive: true })
  writeFileSync(join(paths.workspace, 'project.txt'), 'project marker')
  writeFileSync(join(paths.skills, 'local', 'SKILL.md'), 'local skill marker')
  writeFileSync(join(paths.uploads, 'document.md'), Array.from({ length: 600 }, (_, i) => `line ${i}: uploaded document marker`).join('\n'))
  writeFileSync(join(external, 'enabled', 'SKILL.md'), 'enabled external marker')
  writeFileSync(join(external, 'enabled', 'reference.txt'), 'skill reference marker')
  writeFileSync(join(external, 'disabled', 'SKILL.md'), 'hidden external marker')
  const config: RuntimeFilesystemConfig = { paths, mounts: [{ id: 'shared', root: external, allowed: ['enabled'] }] }
  const tools = new Map(runtimeFileTools(config).map((t) => [t.name, t]))
  const invoke = async (name: string, args: Record<string, unknown>) => String(await tools.get(name)!.invoke(args))
  return { config, invoke }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('shared runtime file mounts', () => {
  it('reads workspace, local and allowed external skill files through the same virtual paths', async () => {
    const { invoke } = fixture()
    expect(await invoke('read_file', { file_path: '/workspace/project.txt' })).toContain('project marker')
    expect(await invoke('read_file', { file_path: '/skills/local/SKILL.md' })).toContain('local skill marker')
    expect(await invoke('read_file', { file_path: '/ext/shared/enabled/reference.txt' })).toContain('skill reference marker')
    await expect(invoke('read_file', { file_path: '/ext/shared/disabled/SKILL.md' })).rejects.toThrow()
  })
  it('reads the later lines of uploaded documents and keeps returned search paths usable', async () => {
    const { invoke } = fixture()
    const content = await invoke('read_file', { file_path: '/uploads/document.md', offset: 550, limit: 2 })
    expect(content).toContain('line 550: uploaded document marker')
    expect(content).toContain('line 551: uploaded document marker')
    expect(content).not.toContain('line 549:')
    const search = await invoke('grep', { path: '/uploads/', pattern: 'line 599:' })
    expect(search).toContain('/uploads/document.md')
    expect(await invoke('grep', { path: '/ext/shared/', pattern: 'hidden external' })).not.toContain('hidden external')
  })
  it('lists mounts and only enabled external skills', async () => {
    const { invoke } = fixture()
    const roots = JSON.parse(await invoke('ls', { path: '/' })).files.map((f: { path: string }) => f.path)
    expect(roots).toEqual(['/workspace/', '/skills/', '/uploads/', '/ext/shared/'])
    expect(await invoke('ls', { path: '/workspace' })).toContain('/workspace/project.txt')
    expect(await invoke('ls', { path: '/ext' })).toContain('/ext/shared/')
    const skills = await invoke('ls', { path: '/ext/shared/' })
    expect(skills).toContain('/ext/shared/enabled/')
    expect(skills).not.toContain('disabled')
  })
  it('keeps skills and uploads read-only and rejects traversal or unmounted paths', async () => {
    const { config, invoke } = fixture()
    for (const path of ['/skills/local/SKILL.md', '/uploads/document.md', '/ext/shared/enabled/SKILL.md']) {
      await expect(invoke('write_file', { file_path: path, content: 'overwritten' })).rejects.toThrow('read-only')
      await expect(invoke('edit_file', { file_path: path, old_string: 'marker', new_string: 'overwritten' })).rejects.toThrow('read-only')
    }
    for (const path of ['/workspace/../skills/local/SKILL.md', '/ext/shared/enabled/../disabled/SKILL.md', '/tmp/host.txt', 'project.txt'])
      await expect(invoke('read_file', { file_path: path })).rejects.toThrow()
    expect(readFileSync(join(config.paths.skills, 'local', 'SKILL.md'), 'utf8')).toBe('local skill marker')
  })
  it('writes and edits artifacts in the workspace and attributes mounted mutations', async () => {
    const { config, invoke } = fixture()
    await invoke('write_file', { file_path: '/workspace/output.txt', content: 'first' })
    await invoke('edit_file', { file_path: '/workspace/output.txt', old_string: 'first', new_string: 'second' })
    expect(readFileSync(join(config.paths.workspace, 'output.txt'), 'utf8')).toBe('second')
    const changed = vi.fn(async (_path: string) => {})
    const backend = createRuntimeFilesystem(config, changed)
    expect((await backend.write('/workspace/another.txt', 'artifact')).error).toBeUndefined()
    expect((await backend.write('/uploads/another.txt', 'invalid')).error).toBeTruthy()
    expect(changed.mock.calls).toEqual([['/another.txt']])
  })
})
