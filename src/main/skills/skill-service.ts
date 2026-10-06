import { dialog, shell } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Skill, SkillSource, SkillVersionSource } from '@shared/types'
import { db } from '../core/db'
import { paths } from '../core/paths'
import { skillVersions } from './versions'
import { addCustomSource, parseFrontmatter, removeCustomSource, scanSources, sourceInfo, tildify, type SkillMount } from './sources'

export { parseFrontmatter }

/** Enabled local skills live in userData/skills (exposed to the agent), disabled ones in userData/skills-disabled. */
const disabledRoot = () => {
  const d = join(paths.userData, 'skills-disabled')
  mkdirSync(d, { recursive: true })
  return d
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const extId = (mountId: string, dir: string) => `ext:${mountId}/${dir}`

function readLocal(root: string, name: string, enabled: boolean): Skill | null {
  const file = join(root, name, 'SKILL.md')
  if (!existsSync(file)) return null
  const fm = parseFrontmatter(readFileSync(file, 'utf8'))
  return {
    id: name,
    name: fm.name || name,
    description: fm.description ?? '',
    enabled,
    path: join(root, name),
    source: 'local',
    sourceLabel: '本地',
    readOnly: false,
  }
}

function locate(name: string): { root: string; enabled: boolean } | null {
  if (existsSync(join(paths.skills, name, 'SKILL.md'))) return { root: paths.skills, enabled: true }
  if (existsSync(join(disabledRoot(), name, 'SKILL.md'))) return { root: disabledRoot(), enabled: false }
  return null
}

function disabledExternal(): Set<string> {
  const rows = db().prepare("SELECT name FROM skill_state WHERE enabled = 0 AND name LIKE 'ext:%'").all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function listLocal(): Skill[] {
  const out: Skill[] = []
  for (const [root, enabled] of [
    [paths.skills, true],
    [disabledRoot(), false],
  ] as const) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const s = readLocal(root, d.name, enabled)
      if (s) out.push(s)
    }
  }
  return out
}

function findExternal(id: string): { mount: SkillMount; dir: string } | null {
  const m = /^ext:([^/]+)\/(.+)$/.exec(id)
  if (!m) return null
  const mount = scanSources().find((x) => x.id === m[1])
  return mount && mount.skills.some((s) => s.dir === m[2]) ? { mount, dir: m[2] } : null
}

export const skills = {
  list(): Skill[] {
    const local = listLocal()
    const localNames = new Set(local.filter((s) => s.enabled).map((s) => s.name))
    const off = disabledExternal()
    const external: Skill[] = scanSources().flatMap((m) =>
      m.skills.map((s) => ({
        id: extId(m.id, s.dir),
        name: s.name,
        description: s.description,
        enabled: !off.has(extId(m.id, s.dir)),
        path: s.path,
        source: m.id,
        sourceLabel: m.label,
        readOnly: true,
        origin: s.origin,
        shadowed: localNames.has(s.name),
      })),
    )
    return [...local.sort((a, b) => a.name.localeCompare(b.name)), ...external]
  },

  /** Mounts for the agent backend: only enabled, non-shadowed external skills are visible. */
  mounts(): { id: string; root: string; allowed: Set<string> }[] {
    const localNames = new Set(
      listLocal()
        .filter((s) => s.enabled)
        .map((s) => s.name),
    )
    const off = disabledExternal()
    return scanSources()
      .map((m) => ({
        id: m.id,
        root: m.root,
        allowed: new Set(m.skills.filter((s) => !off.has(extId(m.id, s.dir)) && !localNames.has(s.name)).map((s) => s.dir)),
      }))
      .filter((m) => m.allowed.size > 0)
  },

  read(id: string): string {
    const ext = findExternal(id)
    if (ext) return readFileSync(join(ext.mount.root, ext.dir, 'SKILL.md'), 'utf8')
    const loc = locate(id)
    if (!loc) throw new Error(`Skill 不存在: ${id}`)
    return readFileSync(join(loc.root, id, 'SKILL.md'), 'utf8')
  },

  /**
   * Writes a local skill. Every change is versioned (the state before the first tracked change is
   * kept as version 1), so it can be compared and rolled back.
   */
  save(name: string, content: string, meta: { source?: SkillVersionSource; reason?: string; threadId?: string | null } = {}): void {
    if (name.startsWith('ext:')) throw new Error('外部 Skill 是只读的，请先复制到本地')
    if (!NAME_RE.test(name)) throw new Error('Skill 名称只能包含小写字母、数字和连字符')
    const fm = parseFrontmatter(content)
    if (!fm.name || !fm.description) throw new Error('SKILL.md 需要包含 frontmatter 字段 name 和 description')
    if (fm.name !== name) throw new Error(`frontmatter 中的 name (${fm.name}) 必须与目录名 (${name}) 一致`)
    const loc = locate(name)
    const dir = join(loc?.root ?? paths.skills, name)
    const file = join(dir, 'SKILL.md')
    if (existsSync(file) && !skillVersions.latest(name)) skillVersions.record(name, readFileSync(file, 'utf8'), 'import', '开始记录版本前的内容')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, content)
    skillVersions.record(name, content, meta.source ?? 'user', meta.reason ?? '', meta.threadId ?? null)
  },

  /** Makes an earlier version current again (recorded as a new version). */
  rollback(name: string, version: number): void {
    const v = skillVersions.get(name, version)
    if (!v) throw new Error('这个版本不存在')
    this.save(name, v.content, { source: 'rollback', reason: `回滚到版本 ${version}` })
  },

  exists(id: string): boolean {
    return id.startsWith('ext:') ? !!findExternal(id) : !!locate(id)
  },

  delete(id: string): void {
    if (id.startsWith('ext:')) throw new Error('外部 Skill 不能在这里删除，可以禁用它')
    const loc = locate(id)
    if (loc) rmSync(join(loc.root, id), { recursive: true, force: true })
    skillVersions.forget(id)
  },

  setEnabled(id: string, enabled: boolean): void {
    if (id.startsWith('ext:')) {
      db()
        .prepare('INSERT INTO skill_state(name, enabled) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled')
        .run(id, enabled ? 1 : 0)
      return
    }
    const loc = locate(id)
    if (!loc || loc.enabled === enabled) return
    renameSync(join(loc.root, id), join(enabled ? paths.skills : disabledRoot(), id))
  },

  copyToLocal(id: string): Skill {
    const ext = findExternal(id)
    if (!ext) throw new Error('Skill 不存在')
    const src = join(ext.mount.root, ext.dir)
    const fm = parseFrontmatter(readFileSync(join(src, 'SKILL.md'), 'utf8'))
    const name = fm.name && NAME_RE.test(fm.name) ? fm.name : ext.dir.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    if (locate(name)) throw new Error(`本地已存在同名 Skill：${name}`)
    cpSync(src, join(paths.skills, name), { recursive: true, dereference: true })
    return readLocal(paths.skills, name, true)!
  },

  async import(): Promise<Skill[]> {
    const res = await dialog.showOpenDialog({ title: '选择包含 SKILL.md 的文件夹', properties: ['openDirectory', 'multiSelections'] })
    const imported: Skill[] = []
    for (const src of res.filePaths) {
      if (!existsSync(join(src, 'SKILL.md'))) continue
      const fm = parseFrontmatter(readFileSync(join(src, 'SKILL.md'), 'utf8'))
      const name =
        fm.name && NAME_RE.test(fm.name)
          ? fm.name
          : basename(src)
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, '-')
      cpSync(src, join(paths.skills, name), { recursive: true, dereference: true })
      const s = readLocal(paths.skills, name, true)
      if (s) imported.push(s)
    }
    return imported
  },

  reveal(id: string): void {
    const ext = findExternal(id)
    if (ext) return void shell.openPath(join(ext.mount.root, ext.dir))
    const loc = locate(id)
    if (loc) void shell.openPath(join(loc.root, id))
  },

  sources(): SkillSource[] {
    return [{ id: 'local', label: '本地', path: tildify(paths.skills), builtin: true, exists: true, skillCount: listLocal().length }, ...sourceInfo()]
  },

  async addSource(): Promise<SkillSource | null> {
    const res = await dialog.showOpenDialog({ title: '选择 Skill 目录（其中每个子文件夹包含一个 SKILL.md）', properties: ['openDirectory'] })
    const p = res.filePaths[0]
    if (!p) return null
    const src = addCustomSource(p)
    return this.sources().find((s) => s.id === src.id) ?? null
  },

  removeSource(id: string): void {
    removeCustomSource(id)
  },
}
