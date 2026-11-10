import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopedSkillBackend } from '../src/main/skills/scoped-backend'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scoped-'))
  roots.push(root)
  for (const n of ['on', 'off']) {
    mkdirSync(join(root, n))
    writeFileSync(join(root, n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n}\n---\n`)
  }
  return root
}

describe('ScopedSkillBackend', () => {
  it('lists and reads only allowed skill folders', async () => {
    const b = new ScopedSkillBackend(fixture(), new Set(['on']))
    const ls = (await b.ls('/')) as { files?: { path: string }[] }
    expect(ls.files?.map((f) => f.path.replace(/\/$/, ''))).toEqual(['/on'])
    expect(((await b.read('/on/SKILL.md')) as { error?: string }).error).toBeUndefined()
    expect(((await b.read('/off/SKILL.md')) as { error?: string }).error).toBeTruthy()
    const glob = (await b.glob('**/SKILL.md')) as { files?: { path: string }[] }
    expect(glob.files?.every((f) => f.path.includes('/on/'))).toBe(true)
  })

  it('refuses every write', async () => {
    const root = fixture()
    const b = new ScopedSkillBackend(root, new Set(['on']))
    expect((await b.write()).error).toMatch(/只读/)
    expect((await b.edit()).error).toMatch(/只读/)
    expect((await b.delete()).error).toMatch(/只读/)
    expect(readFileSync(join(root, 'on', 'SKILL.md'), 'utf8')).toContain('name: on')
  })

  it.each(['disabled', 'outside'] as const)('blocks directory symlinks to %s files in reads, listings, searches and downloads', async (destination) => {
    const root = fixture()
    const outside = fixture()
    const target = destination === 'disabled' ? join(root, 'off') : join(outside, 'on')
    writeFileSync(join(target, 'secret.txt'), 'hidden target marker')
    symlinkSync(target, join(root, 'on', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const b = new ScopedSkillBackend(root, new Set(['on']))
    const file = '/on/link/secret.txt'
    expect(await b.read(file)).toHaveProperty('error')
    expect(await b.readRaw(file)).toHaveProperty('error')
    expect(await b.ls('/on/link')).toHaveProperty('error')
    expect(await b.grep('hidden target marker', '/on/link')).toEqual({ matches: [] })
    expect(await b.glob('**/*', '/on/link')).toEqual({ files: [] })
    expect(await b.downloadFiles([file])).toEqual([])
    expect(JSON.stringify(await b.ls('/on'))).not.toContain('/on/link')
    expect(JSON.stringify(await b.grep('hidden target marker', '/'))).not.toContain('hidden target marker')
    expect(JSON.stringify(await b.glob('**/*', '/'))).not.toContain('secret.txt')
  })

  it('fails closed for broken links, traversal and missing paths', async () => {
    const root = fixture()
    symlinkSync(join(root, 'missing'), join(root, 'on', 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
    const b = new ScopedSkillBackend(root, new Set(['on']))
    for (const file of ['/on/broken/file', '/on/../off/SKILL.md', '/on\\..\\off\\SKILL.md', '/on/missing']) {
      expect(await b.read(file)).toHaveProperty('error')
      expect(await b.downloadFiles([file])).toEqual([])
    }
    expect(JSON.stringify(await b.ls('/on'))).not.toContain('broken')
  })

  it('preserves unrestricted read-only local mounts and valid allowed directory links', async () => {
    const root = fixture()
    mkdirSync(join(root, 'on', 'sub'))
    writeFileSync(join(root, 'on', 'sub', 'reference.txt'), 'allowed reference')
    symlinkSync(join(root, 'on', 'sub'), join(root, 'on', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const scoped = new ScopedSkillBackend(root, new Set(['on']))
    expect(JSON.stringify(await scoped.read('/on/link/reference.txt'))).toContain('allowed reference')
    const local = new ScopedSkillBackend(root, null)
    expect(JSON.stringify(await local.read('/off/SKILL.md'))).toContain('name: off')
    expect(await local.write()).toHaveProperty('error')
  })
})
