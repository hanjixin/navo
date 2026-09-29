import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScopedSkillBackend } from '../src/main/skills/scoped-backend'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scoped-'))
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
})
