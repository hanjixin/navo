import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { DiscoveredMcp, McpServer, McpTransport } from '@shared/types'
import { log } from '../core/logger'
import { CATALOG } from '../connectors/catalog'
import { tildify } from '../skills/sources'

type RawEntry = Record<string, unknown>
interface Found {
  sourceId: string
  sourceLabel: string
  sourcePath: string
  name: string
  raw: RawEntry
}

const home = homedir()
const appData =
  process.platform === 'win32'
    ? (process.env.APPDATA ?? join(home, 'AppData/Roaming'))
    : process.platform === 'darwin'
      ? join(home, 'Library/Application Support')
      : join(home, '.config')

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    log.warn(`[discover] cannot parse ${path}: ${(err as Error).message}`)
    return null
  }
}

function entries(obj: unknown): [string, RawEntry][] {
  return obj && typeof obj === 'object' ? (Object.entries(obj) as [string, RawEntry][]).filter(([, v]) => v && typeof v === 'object') : []
}

/** Each reader knows one tool's config format. */
const READERS: { id: string; label: string; path: string; read: (path: string) => [string, RawEntry][] | { label: string; items: [string, RawEntry][] }[] }[] =
  [
    {
      id: 'agents',
      label: '.agents',
      path: join(home, '.agents/mcp.json'),
      read: (p) => {
        const j = readJson(p)
        return entries(j?.mcpServers ?? j?.servers ?? j)
      },
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      path: join(home, '.claude.json'),
      read: (p) => {
        const j = readJson(p) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | null
        if (!j) return []
        const groups = [{ label: 'Claude Code', items: entries(j.mcpServers) }]
        for (const [proj, v] of Object.entries(j.projects ?? {})) {
          const items = entries(v?.mcpServers)
          if (items.length) groups.push({ label: `Claude Code · ${proj === home ? '~' : basename(proj)}`, items })
        }
        return groups
      },
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      path: join(appData, 'Claude/claude_desktop_config.json'),
      read: (p) => entries(readJson(p)?.mcpServers),
    },
    { id: 'cursor', label: 'Cursor', path: join(home, '.cursor/mcp.json'), read: (p) => entries(readJson(p)?.mcpServers) },
    {
      id: 'codex',
      label: 'Codex',
      path: join(home, '.codex/config.toml'),
      read: (p) => {
        if (!existsSync(p)) return []
        try {
          return entries((parseToml(readFileSync(p, 'utf8')) as { mcp_servers?: unknown }).mcp_servers)
        } catch (err) {
          log.warn(`[discover] cannot parse ${p}: ${(err as Error).message}`)
          return []
        }
      },
    },
    { id: 'gemini', label: 'Gemini CLI', path: join(home, '.gemini/settings.json'), read: (p) => entries(readJson(p)?.mcpServers) },
    { id: 'vscode', label: 'VS Code', path: join(appData, 'Code/User/mcp.json'), read: (p) => entries(readJson(p)?.servers) },
  ]

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const strMap = (v: unknown) =>
  v && typeof v === 'object' ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string>) : null

function normalize(f: Found): Omit<DiscoveredMcp, 'imported' | 'connectorId'> | null {
  const r = f.raw
  const url = str(r.url) ?? str(r.httpUrl) ?? str(r.serverUrl)
  const command = str(r.command)
  if (!url && !command) return null
  const type = str(r.type) ?? str(r.transport)
  const transport: McpTransport = url ? (type === 'sse' || (!type && /\/sse\/?$/.test(url) && !r.httpUrl) ? 'sse' : 'http') : 'stdio'
  return {
    key: `${f.sourceId}:${f.sourceLabel}:${f.name}`,
    name: f.name,
    sourceId: f.sourceId,
    sourceLabel: f.sourceLabel,
    sourcePath: tildify(f.sourcePath),
    transport,
    command,
    args: Array.isArray(r.args) ? r.args.map(String) : null,
    env: strMap(r.env),
    url,
    headers: strMap(r.headers) ?? strMap(r.http_headers),
  }
}

const signature = (s: { transport: string; command?: string | null; args?: string[] | null; url?: string | null }) =>
  s.transport === 'stdio' ? `stdio|${s.command}|${(s.args ?? []).join(' ')}` : `url|${(s.url ?? '').replace(/\/+$/, '')}`

const host = (u?: string | null) => {
  try {
    return u ? new URL(u).host : null
  } catch {
    return null
  }
}

/** Scans other agents' configs for MCP servers. Duplicates across tools are collapsed. */
export function discoverMcp(existing: McpServer[]): DiscoveredMcp[] {
  const found: Found[] = []
  for (const r of READERS) {
    if (!existsSync(r.path)) continue
    const res = r.read(r.path)
    const groups =
      res.length && Array.isArray(res[0]) ? [{ label: r.label, items: res as [string, RawEntry][] }] : (res as { label: string; items: [string, RawEntry][] }[])
    for (const g of groups) for (const [name, raw] of g.items) found.push({ sourceId: r.id, sourceLabel: g.label, sourcePath: r.path, name, raw })
  }
  const have = new Set(existing.map(signature))
  const seen = new Set<string>()
  const out: DiscoveredMcp[] = []
  for (const f of found) {
    const n = normalize(f)
    if (!n) continue
    const sig = signature(n)
    if (seen.has(sig)) continue
    seen.add(sig)
    const h = host(n.url)
    const connectorId = h ? CATALOG.find((c) => host(c.mcpUrl) === h)?.id : undefined
    out.push({ ...n, connectorId, imported: have.has(sig) })
  }
  return out
}
