import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SkillSource } from '@shared/types'
import { kv } from '../core/db'

/** Well-known skill folders shared with other agents. `.agents` is the cross-agent convention used by the `skills` CLI. */
const BUILTIN = [
  { id: 'agents', label: '.agents', path: '~/.agents/skills' },
  { id: 'claude', label: 'Claude Code', path: '~/.claude/skills' },
  { id: 'codex', label: 'Codex', path: '~/.codex/skills' },
]

export const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
export const tildify = (p: string) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p)

interface CustomSource {
  id: string
  label: string
  path: string
}

export interface ExternalSkill {
  dir: string
  name: string
  description: string
  path: string
  origin?: string
}

/** A directory mounted into the agent filesystem at /ext/<id>/ (always a real, symlink-free path). */
export interface SkillMount {
  id: string
  sourceId: string
  label: string
  root: string
  skills: ExternalSkill[]
}

export { parseFrontmatter } from './frontmatter'
import { parseFrontmatter } from './frontmatter'

function customSources(): CustomSource[] {
  return kv.get<CustomSource[]>('skills.customSources', [])
}

export function allSources(): (CustomSource & { builtin: boolean })[] {
  return [...BUILTIN.map((s) => ({ ...s, builtin: true })), ...customSources().map((s) => ({ ...s, builtin: false }))]
}

export function addCustomSource(path: string): CustomSource {
  const list = customSources()
  const existing = list.find((s) => expandHome(s.path) === path)
  if (existing) return existing
  const src = { id: `custom-${Date.now().toString(36)}`, label: basename(path), path: tildify(path) }
  kv.set('skills.customSources', [...list, src])
  return src
}

export function removeCustomSource(id: string): void {
  kv.set(
    'skills.customSources',
    customSources().filter((s) => s.id !== id),
  )
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Origins recorded by the `skills` CLI (`~/.agents/.skill-lock.json`). */
function lockOrigins(sourceRoot: string): Record<string, string> {
  const lock = join(dirname(sourceRoot), '.skill-lock.json')
  if (!existsSync(lock)) return {}
  try {
    const data = JSON.parse(readFileSync(lock, 'utf8')) as { skills?: Record<string, { source?: string }> }
    return Object.fromEntries(Object.entries(data.skills ?? {}).map(([k, v]) => [k, v.source ?? '']))
  } catch {
    return {}
  }
}

function readSkill(root: string, dir: string, origins: Record<string, string>): ExternalSkill | null {
  const file = join(root, dir, 'SKILL.md')
  if (!existsSync(file)) return null
  try {
    const fm = parseFrontmatter(readFileSync(file, 'utf8'))
    return { dir, name: fm.name || dir, description: fm.description ?? '', path: join(root, dir), origin: origins[dir] || undefined }
  } catch {
    return null
  }
}

const mountId = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Scans every source. Skill folders directly inside a source are mounted together; folders that
 * hold a collection of skills (e.g. `~/.agents/skills/superpowers -> ~/.codex/superpowers/skills`)
 * get their own mount so symlinks never have to be followed by the agent filesystem.
 */
export function scanSources(): SkillMount[] {
  const mounts: SkillMount[] = []
  const seenRoots = new Set<string>()
  // real paths of every skill folder already mounted, so symlinked copies (e.g. ~/.claude/skills/x -> ~/.agents/skills/x) appear once
  const seenSkills = new Set<string>()
  const seen = (p: string) => {
    const r = realpathSync(p)
    if (seenSkills.has(r)) return true
    seenSkills.add(r)
    return false
  }
  for (const src of allSources()) {
    const base = expandHome(src.path)
    if (!isDir(base)) continue
    const root = realpathSync(base)
    if (seenRoots.has(root)) continue
    seenRoots.add(root)
    const origins = lockOrigins(base)
    const direct: ExternalSkill[] = []
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      const full = join(root, d.name)
      if (!isDir(full)) continue
      if (d.isSymbolicLink() || !existsSync(join(full, 'SKILL.md'))) {
        // symlinked skill or a nested collection: mount its real path separately
        const real = realpathSync(full)
        if (seenRoots.has(real)) continue
        if (existsSync(join(real, 'SKILL.md'))) {
          if (seen(real)) continue
          const one = readSkill(dirname(real), basename(real), { [basename(real)]: origins[d.name] ?? '' })
          if (one) mounts.push({ id: mountId(`${src.id}-${d.name}`), sourceId: src.id, label: `${src.label}/${d.name}`, root: dirname(real), skills: [one] })
          continue
        }
        const nested = readdirSync(real, { withFileTypes: true })
          .filter((n) => !n.name.startsWith('.') && isDir(join(real, n.name)) && !n.isSymbolicLink())
          .map((n) => readSkill(real, n.name, {}))
          .filter((x): x is ExternalSkill => !!x && !seen(x.path))
        if (nested.length) {
          seenRoots.add(real)
          mounts.push({ id: mountId(`${src.id}-${d.name}`), sourceId: src.id, label: `${src.label}/${d.name}`, root: real, skills: nested })
        }
        continue
      }
      const s = readSkill(root, d.name, origins)
      if (s && !seen(s.path)) direct.push(s)
    }
    if (direct.length) mounts.push({ id: mountId(src.id), sourceId: src.id, label: src.label, root, skills: direct })
  }
  return mounts
}

export function sourceInfo(mounts = scanSources()): SkillSource[] {
  return allSources().map((s) => ({
    id: s.id,
    label: s.label,
    path: s.path,
    builtin: s.builtin,
    exists: isDir(expandHome(s.path)),
    skillCount: mounts.filter((m) => m.sourceId === s.id).reduce((n, m) => n + m.skills.length, 0),
  }))
}
