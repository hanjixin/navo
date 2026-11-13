import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DiscoveredSkill, SkillInstallResult } from '@shared/types'
import { paths } from '../core/paths'
import { parseFrontmatter } from './frontmatter'
import { skillVersions } from './versions'

const REGISTRY = 'https://skills.sh'
const SEARCH_LIMIT = 30
const GITHUB_API = 'https://api.github.com'
const MAX_FILES = 300
const MAX_BYTES = 8 * 1024 * 1024
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/

function sourceUrl(source: string): string {
  if (!SOURCE_RE.test(source)) throw new Error('Skill 来源必须是 GitHub owner/repository')
  return `https://github.com/${source}.git`
}

function skillPage(source: string, skillId: string): string {
  if (!SOURCE_RE.test(source) || !SKILL_RE.test(skillId)) throw new Error('Skill 来源或名称无效')
  return `${REGISTRY}/${source}/${encodeURIComponent(skillId)}`
}

function normalizeResult(value: unknown): DiscoveredSkill | null {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const source = typeof row?.source === 'string' ? row.source : ''
  const skillId = typeof row?.skillId === 'string' ? row.skillId : ''
  const name = typeof row?.name === 'string' ? row.name : skillId
  if (!SOURCE_RE.test(source) || !SKILL_RE.test(skillId) || !name) return null
  const installs = typeof row?.installs === 'number' && Number.isFinite(row.installs) ? row.installs : 0
  return {
    id: `${source}/${skillId}`,
    source,
    skillId,
    name,
    installs,
    url: skillPage(source, skillId),
    installCommand: `npx skills add https://github.com/${source} --skill ${skillId}`,
  }
}

function htmlMeta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html)
  return match?.[1]
    ?.replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function findInstallCommand(html: string): string | undefined {
  return /npx\s+skills\s+add\s+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\s+--skill\s+[A-Za-z0-9._-]+/i.exec(html)?.[0]
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json,text/html', 'user-agent': 'Navo Skill installer' },
  })
  if (!response.ok) throw new Error(`Skill registry request failed (${response.status})`)
  return response.text()
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Navo Skill installer' },
  })
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`)
  return (await response.json()) as T
}

interface GithubTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
}

async function downloadGithubSkill(source: string, skillId: string, destination: string): Promise<string> {
  const repo = await fetchJson<{ default_branch?: string }>(`${GITHUB_API}/repos/${source}`)
  const branch = repo.default_branch || 'main'
  const tree = await fetchJson<{ tree?: GithubTreeEntry[]; truncated?: boolean }>(
    `${GITHUB_API}/repos/${source}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  )
  if (tree.truncated) throw new Error('Skill 仓库太大，暂不支持安装')
  const entries = tree.tree ?? []
  const skillFiles = entries.filter((entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md'))
  const candidate = skillFiles.find((entry) => basename(entry.path.slice(0, -'/SKILL.md'.length)) === skillId)
  if (!candidate) throw new Error(`仓库中没有找到 Skill「${skillId}」的 SKILL.md`)
  const root = candidate.path.slice(0, -'/SKILL.md'.length)
  const selected = entries.filter((entry) => entry.path === root || entry.path.startsWith(`${root}/`))
  if (selected.some((entry) => entry.mode === '120000')) throw new Error('Skill 包含符号链接，已停止安装以保护本地文件')
  const files = selected.filter((entry) => entry.type === 'blob')
  if (!files.length || files.length > MAX_FILES) throw new Error('Skill 文件数量超过限制')
  let total = 0
  for (const entry of files) {
    const rel = entry.path.slice(root.length).replace(/^\/+/, '')
    if (!rel || rel.split('/').some((part) => part === '.' || part === '..')) throw new Error('Skill 路径无效')
    const blob = await fetchJson<{ content?: string; encoding?: string; size?: number }>(`${GITHUB_API}/repos/${source}/git/blobs/${entry.sha}`)
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('GitHub 返回了不支持的文件格式')
    const data = Buffer.from(blob.content.replace(/\s/g, ''), 'base64')
    total += data.length
    if (total > MAX_BYTES) throw new Error('Skill 文件总大小超过限制')
    const out = join(destination, rel)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, data, { flag: 'wx' })
  }
  return destination
}

export function assertNoSymlinks(root: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 包含符号链接，已停止安装以保护本地文件')
      if (entry.isDirectory() && entry.name !== '.git') walk(join(dir, entry.name))
    }
  }
  walk(root)
}

export const skillDiscovery = {
  async search(query: string): Promise<DiscoveredSkill[]> {
    const q = query.trim()
    if (q.length < 2) return []
    const parsed = (JSON.parse(await fetchText(`${REGISTRY}/api/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`)) ?? {}) as { skills?: unknown[] }
    return (parsed.skills ?? []).map(normalizeResult).filter((v): v is DiscoveredSkill => !!v)
  },
  async details(source: string, skillId: string): Promise<{ url: string; description?: string; command: string }> {
    const html = await fetchText(skillPage(source, skillId))
    const base = normalizeResult({ source, skillId, name: skillId, installs: 0 })!
    return {
      url: base.url!,
      description: htmlMeta(html, 'description') ?? htmlMeta(html, 'og:description'),
      command: findInstallCommand(html) ?? base.installCommand!,
    }
  },
  async install(source: string, skillId: string): Promise<SkillInstallResult> {
    sourceUrl(source)
    if (!SKILL_RE.test(skillId)) throw new Error('Skill 名称无效')
    const name = skillId.toLowerCase()
    const destination = join(paths.skills, name)
    const temp = await mkdtemp(join(tmpdir(), 'navo-find-skill-'))
    const backup = await mkdtemp(join(tmpdir(), 'navo-find-skill-backup-'))
    let existed = false
    try {
      const downloaded = join(temp, 'skill')
      const found = await downloadGithubSkill(source, skillId, downloaded)
      assertNoSymlinks(found)
      const frontmatter = parseFrontmatter(readFileSync(join(found, 'SKILL.md'), 'utf8'))
      if (!frontmatter.name || !frontmatter.description) throw new Error('Skill 的 SKILL.md 缺少 name 或 description')
      const realFound = realpathSync(found)
      existed = existsSync(destination)
      if (existed) {
        const oldContent = readFileSync(join(destination, 'SKILL.md'), 'utf8')
        skillVersions.record(name, oldContent, 'import', `安装 ${source}/${skillId} 前的本地版本`)
        await copyTree(destination, backup)
        await rm(destination, { recursive: true, force: true })
      }
      await mkdir(destination, { recursive: true })
      for (const entry of readdirSync(realFound, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Skill 包含符号链接，已停止安装以保护本地文件')
      }
      const files = readdirSync(realFound, { recursive: true, withFileTypes: true })
      for (const entry of files) {
        if (entry.isSymbolicLink()) throw new Error('Skill 包含符号链接，已停止安装以保护本地文件')
      }
      const sourceRoot = realFound
      const copy = async (dir: string, rel = ''): Promise<void> => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const from = join(dir, entry.name)
          const to = join(destination, rel, entry.name)
          if (entry.isDirectory()) {
            await mkdir(to, { recursive: true })
            await copy(from, join(rel, entry.name))
          } else if (entry.isFile()) {
            await mkdir(dirname(to), { recursive: true })
            await writeFile(to, readFileSync(from), { flag: 'wx' })
          }
        }
      }
      await copy(sourceRoot)
      const installedContent = readFileSync(join(destination, 'SKILL.md'), 'utf8')
      skillVersions.record(name, installedContent, 'import', `从 ${source}/${skillId} 安装`)
      return { name, path: destination, source, skillId, overwritten: existed }
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined)
      if (existed) await copyTree(backup, destination).catch(() => undefined)
      throw error
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await writeFile(to, readFileSync(from), { flag: 'wx' })
    else throw new Error('Skill 包含不支持的文件类型')
  }
}
