import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { DiscoveredMcp, McpServer, McpStatus } from '@shared/types'
import { discoverMcp } from './discovery'
import { isNavoSelfUrl } from '../mcp-server/self'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { shellPath } from '../core/shell-env'
import { secrets } from '../core/secrets'

interface Row {
  id: string
  name: string
  transport: McpServer['transport']
  command: string | null
  args: string | null
  env: string | null
  url: string | null
  headers: string | null
  enabled: number
}

/** env and headers routinely hold API keys, so they live in the OS keychain (safeStorage), not in SQLite. */
const secretKey = (id: string) => `mcp:${id}`
type McpSecrets = { env: Record<string, string> | null; headers: Record<string, string> | null }

function readSecrets(id: string): McpSecrets {
  const raw = secrets.get(secretKey(id))
  return raw ? (JSON.parse(raw) as McpSecrets) : { env: null, headers: null }
}

function writeSecrets(id: string, v: McpSecrets): void {
  if (!v.env && !v.headers) secrets.delete(secretKey(id))
  else secrets.set(secretKey(id), JSON.stringify(v))
}

const toServer = (r: Row): McpServer => {
  const sec = readSecrets(r.id)
  return {
    id: r.id,
    name: r.name,
    transport: r.transport,
    command: r.command,
    args: json.parse(r.args),
    env: sec.env ?? json.parse(r.env),
    url: r.url,
    headers: sec.headers ?? json.parse(r.headers),
    enabled: !!r.enabled,
  }
}

interface Conn {
  client: MultiServerMCPClient
  tools: StructuredToolInterface[]
}

export interface McpEndpoint {
  name: string
  transport: McpServer['transport']
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  authProvider?: OAuthClientProvider
}

export async function connectEndpoint(ep: McpEndpoint): Promise<Conn> {
  const safeName = ep.name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const connection =
    ep.transport === 'stdio'
      ? {
          transport: 'stdio' as const,
          command: ep.command ?? '',
          args: ep.args ?? [],
          env: { ...(process.env as Record<string, string>), PATH: shellPath(), ...(ep.env ?? {}) },
          restart: { enabled: true, maxAttempts: 3, delayMs: 1000 },
        }
      : {
          transport: ep.transport,
          url: ep.url ?? '',
          headers: ep.headers ?? undefined,
          authProvider: ep.authProvider,
          reconnect: { enabled: true, maxAttempts: 3, delayMs: 1000 },
        }
  const client = new MultiServerMCPClient({
    mcpServers: { [safeName]: connection },
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: 'mcp',
    useStandardContentBlocks: true,
    onConnectionError: 'throw',
  })
  const tools = await client.getTools()
  return { client, tools }
}

class McpService {
  private conns = new Map<string, Conn>()
  private statuses = new Map<string, McpStatus>()

  list(): McpServer[] {
    return (db().prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Row[]).map(toServer)
  }

  get(id: string): McpServer | null {
    const r = db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined
    return r ? toServer(r) : null
  }

  async save(input: Omit<McpServer, 'id'> & { id?: string }): Promise<McpServer> {
    if (!input.name.trim()) throw new Error('名称不能为空')
    if (input.transport === 'stdio' && !input.command) throw new Error('stdio 需要填写命令')
    if (input.transport !== 'stdio' && !input.url) throw new Error('需要填写 URL')
    if (isNavoSelfUrl(input.url)) throw new Error('这是 Navo 自己对外提供的 MCP 服务，不能再添加到 Navo 中（会让 Agent 调用自己）')
    const id = input.id ?? newId()
    db()
      .prepare(
        `INSERT INTO mcp_servers(id, name, transport, command, args, env, url, headers, enabled)
         VALUES(@id, @name, @transport, @command, @args, @env, @url, @headers, @enabled)
         ON CONFLICT(id) DO UPDATE SET name=@name, transport=@transport, command=@command, args=@args, env=@env, url=@url, headers=@headers, enabled=@enabled`,
      )
      .run({
        id,
        name: input.name.trim(),
        transport: input.transport,
        command: input.command ?? null,
        args: json.str(input.args),
        env: null,
        url: input.url ?? null,
        headers: null,
        enabled: input.enabled ? 1 : 0,
      })
    writeSecrets(id, {
      env: input.env && Object.keys(input.env).length ? input.env : null,
      headers: input.headers && Object.keys(input.headers).length ? input.headers : null,
    })
    const server = this.get(id)!
    void this.reconnect(id)
    return server
  }

  async delete(id: string): Promise<void> {
    await this.disconnect(id)
    db().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    secrets.delete(secretKey(id))
    this.statuses.delete(id)
    this.push()
  }

  /** Accepts Claude Desktop / Cursor style `{ "mcpServers": { name: {command,args,env} | {url} } }`. */
  async importJson(text: string): Promise<McpServer[]> {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, Record<string, unknown>> }
    const entries = Object.entries(parsed.mcpServers ?? (parsed as Record<string, Record<string, unknown>>))
    const out: McpServer[] = []
    for (const [name, c] of entries) {
      const url = typeof c.url === 'string' ? c.url : null
      out.push(
        await this.save({
          name,
          transport: url ? (c.type === 'sse' || c.transport === 'sse' ? 'sse' : 'http') : 'stdio',
          command: (c.command as string) ?? null,
          args: (c.args as string[]) ?? [],
          env: (c.env as Record<string, string>) ?? null,
          url,
          headers: (c.headers as Record<string, string>) ?? null,
          enabled: true,
        }),
      )
    }
    return out
  }

  discover(): DiscoveredMcp[] {
    return discoverMcp(this.list()).filter((d) => !isNavoSelfUrl(d.url))
  }

  async importDiscovered(keys: string[]): Promise<McpServer[]> {
    const found = this.discover().filter((d) => keys.includes(d.key) && !d.imported)
    const names = new Set(this.list().map((s) => s.name))
    const out: McpServer[] = []
    for (const d of found) {
      let name = d.name
      if (names.has(name)) name = `${d.name} (${d.sourceLabel})`
      names.add(name)
      out.push(await this.save({ name, transport: d.transport, command: d.command, args: d.args, env: d.env, url: d.url, headers: d.headers, enabled: true }))
    }
    return out
  }

  status(): McpStatus[] {
    return this.list().map((s) => this.statuses.get(s.id) ?? { id: s.id, state: 'disconnected', tools: [] })
  }

  private push(): void {
    emit('mcp.status', this.status())
  }

  private setStatus(s: McpStatus): void {
    this.statuses.set(s.id, s)
    this.push()
  }

  /** One-time move of plaintext env/headers (older versions) into the keychain. */
  migrateSecrets(): void {
    const rows = db().prepare('SELECT * FROM mcp_servers WHERE env IS NOT NULL OR headers IS NOT NULL').all() as Row[]
    for (const r of rows) {
      const prev = readSecrets(r.id)
      writeSecrets(r.id, { env: prev.env ?? json.parse(r.env), headers: prev.headers ?? json.parse(r.headers) })
      db().prepare('UPDATE mcp_servers SET env = NULL, headers = NULL WHERE id = ?').run(r.id)
    }
    if (rows.length) log.info(`[mcp] moved secrets of ${rows.length} server(s) into the keychain`)
  }

  async connectAll(): Promise<void> {
    this.migrateSecrets()
    await Promise.all(
      this.list()
        .filter((s) => s.enabled)
        .map((s) => this.reconnect(s.id)),
    )
  }

  async disconnect(id: string): Promise<void> {
    const c = this.conns.get(id)
    this.conns.delete(id)
    await c?.client.close().catch(() => undefined)
  }

  async reconnect(id: string): Promise<void> {
    await this.disconnect(id)
    const server = this.get(id)
    if (!server || !server.enabled) {
      this.setStatus({ id, state: 'disconnected', tools: [] })
      return
    }
    this.setStatus({ id, state: 'connecting', tools: [] })
    try {
      const conn = await connectEndpoint(server)
      this.conns.set(id, conn)
      this.setStatus({ id, state: 'connected', tools: conn.tools.map((t) => ({ name: t.name, description: t.description })) })
      log.info(`[mcp] ${server.name} connected with ${conn.tools.length} tools`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`[mcp] ${server.name} failed: ${error}`)
      this.setStatus({ id, state: 'error', error, tools: [] })
    }
  }

  tools(): StructuredToolInterface[] {
    return [...this.conns.values()].flatMap((c) => c.tools)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)))
  }
}

export const mcp = new McpService()
