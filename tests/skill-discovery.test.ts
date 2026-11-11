import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/main/core/paths', () => ({ paths: { skills: '/tmp/navo-skills' } }))

import { assertNoSymlinks, skillDiscovery } from '../src/main/skills/discovery'

afterEach(() => vi.unstubAllGlobals())

describe('public Skill discovery', () => {
  it('searches skills.sh and normalizes safe install metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              skills: [
                { source: 'owner/repo', skillId: 'research', name: 'Research', installs: 1234 },
                { source: '../escape', skillId: 'bad', name: 'Bad', installs: 99 },
              ],
            }),
          ),
      ),
    )
    await expect(skillDiscovery.search('research')).resolves.toEqual([
      expect.objectContaining({
        id: 'owner/repo/research',
        source: 'owner/repo',
        skillId: 'research',
        installs: 1234,
        url: 'https://skills.sh/owner/repo/research',
        installCommand: 'npx skills add https://github.com/owner/repo --skill research',
      }),
    ])
  })

  it('does not call the registry for short queries', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(skillDiscovery.search(' r ')).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('extracts a description and official install command from a skill page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<meta name="description" content="A useful workflow"><code>npx skills add https://github.com/owner/repo --skill research</code>'),
      ),
    )
    await expect(skillDiscovery.details('owner/repo', 'research')).resolves.toEqual({
      url: 'https://skills.sh/owner/repo/research',
      description: 'A useful workflow',
      command: 'npx skills add https://github.com/owner/repo --skill research',
    })
  })

  it('rejects untrusted repository and skill identifiers before cloning', async () => {
    await expect(skillDiscovery.install('https://evil.example/x', 'research')).rejects.toThrow('GitHub')
    await expect(skillDiscovery.install('owner/repo', '../research')).rejects.toThrow('名称无效')
  })

  it('rejects symlinks inside a downloaded Skill tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'navo-skill-tree-'))
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'SKILL.md'), '---\nname: safe\ndescription: safe\n---\n')
    symlinkSync('/tmp', join(root, 'nested', 'outside'))
    expect(() => assertNoSymlinks(root)).toThrow('符号链接')
  })
})
