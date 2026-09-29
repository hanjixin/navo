import type { StructuredToolInterface } from '@langchain/core/tools'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { ConnectorDef, ConnectorState } from '@shared/types'
import { db, json } from '../core/db'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { secrets } from '../core/secrets'
import { connectEndpoint } from '../mcp/mcp-service'
import { CATALOG } from './catalog'
import { isNavoSelfUrl } from '../mcp-server/self'
import { StoredOAuthProvider, waitForAuthCode } from './oauth'

interface Row {
  id: string
  connected: number
  enabled: number
  connected_at: number | null
  error: string | null
  custom_def: string | null
}

type Live = { tools: StructuredToolInterface[]; close: () => Promise<void> }

class ConnectorService {
  private live = new Map<string, Live>()

  catalog(): ConnectorDef[] {
    const custom = (db().prepare('SELECT custom_def FROM connectors WHERE custom_def IS NOT NULL').all() as Row[])
      .map((r) => json.parse<ConnectorDef>(r.custom_def))
      .filter((d): d is ConnectorDef => !!d)
    return [...CATALOG, ...custom]
  }

  def(id: string): ConnectorDef {
    const d = this.catalog().find((c) => c.id === id)
    if (!d) throw new Error(`未知连接器: ${id}`)
    return d
  }

  private row(id: string): Row | undefined {
    return db().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Row | undefined
  }

  private upsert(id: string, patch: Partial<Omit<Row, 'id'>>): void {
    const cur = this.row(id) ?? { id, connected: 0, enabled: 1, connected_at: null, error: null, custom_def: null }
    const next = { ...cur, ...patch }
    db()
      .prepare(
        `INSERT INTO connectors(id, connected, enabled, connected_at, error, custom_def) VALUES(@id, @connected, @enabled, @connected_at, @error, @custom_def)
         ON CONFLICT(id) DO UPDATE SET connected=@connected, enabled=@enabled, connected_at=@connected_at, error=@error, custom_def=@custom_def`,
      )
      .run(next)
    emit('connectors.changed')
  }

  states(): ConnectorState[] {
    return this.catalog().map((d) => {
      const r = this.row(d.id)
      return {
        id: d.id,
        connected: !!r?.connected,
        enabled: r ? !!r.enabled : true,
        connectedAt: r?.connected_at,
        error: r?.error,
      }
    })
  }

  private state(id: string): ConnectorState {
    return this.states().find((s) => s.id === id)!
  }

  async connect(id: string, token?: string): Promise<ConnectorState> {
    const def = this.def(id)
    if (!def.mcpUrl) throw new Error('该连接器缺少 MCP 地址')
    try {
      if (def.auth === 'token') {
        if (!token && !secrets.has(`connector:${id}`)) throw new Error(`请填写 ${def.tokenLabel ?? 'Token'}`)
        if (token) secrets.set(`connector:${id}`, token)
      } else if (def.auth === 'oauth') {
        const provider = new StoredOAuthProvider(id)
        const first = await auth(provider, { serverUrl: def.mcpUrl })
        if (first === 'REDIRECT') {
          const code = await waitForAuthCode()
          await auth(provider, { serverUrl: def.mcpUrl, authorizationCode: code })
        }
      }
      await this.start(def)
      this.upsert(id, { connected: 1, enabled: 1, connected_at: Date.now(), error: null })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn(`[connector] ${id} connect failed: ${error}`)
      this.upsert(id, { connected: 0, error })
      throw err
    }
    return this.state(id)
  }

  private async start(def: ConnectorDef): Promise<void> {
    await this.stop(def.id)
    const token = def.auth === 'token' ? secrets.get(`connector:${def.id}`) : null
    const conn = await connectEndpoint({
      name: def.id,
      transport: def.mcpUrl?.endsWith('/sse') ? 'sse' : 'http',
      url: def.mcpUrl,
      headers: token ? { Authorization: `Bearer ${token}` } : null,
      authProvider: def.auth === 'oauth' ? new StoredOAuthProvider(def.id) : undefined,
    })
    this.live.set(def.id, { tools: conn.tools, close: () => conn.client.close() })
    log.info(`[connector] ${def.id} ready with ${conn.tools.length} tools`)
  }

  private async stop(id: string): Promise<void> {
    const l = this.live.get(id)
    this.live.delete(id)
    await l?.close().catch(() => undefined)
  }

  async disconnect(id: string): Promise<void> {
    await this.stop(id)
    secrets.delete(`connector:${id}`)
    new StoredOAuthProvider(id).clear()
    this.upsert(id, { connected: 0, connected_at: null, error: null })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.upsert(id, { enabled: enabled ? 1 : 0 })
    if (!enabled) await this.stop(id)
    else if (this.row(id)?.connected) await this.start(this.def(id)).catch((e) => this.upsert(id, { error: String(e.message ?? e) }))
  }

  addCustom(input: Omit<ConnectorDef, 'id' | 'custom' | 'icon'>): ConnectorDef {
    if (!input.name.trim() || !input.mcpUrl) throw new Error('名称和 MCP 地址必填')
    if (isNavoSelfUrl(input.mcpUrl)) throw new Error('这是 Navo 自己对外提供的 MCP 服务，不能作为连接器添加')
    const def: ConnectorDef = { ...input, id: `custom-${Date.now().toString(36)}`, icon: 'plug', custom: true }
    this.upsert(def.id, { custom_def: JSON.stringify(def), connected: 0 })
    return def
  }

  async startAll(): Promise<void> {
    for (const s of this.states()) {
      if (s.connected && s.enabled) {
        await this.start(this.def(s.id)).catch((e) => {
          log.warn(`[connector] ${s.id} restart failed: ${e.message}`)
          this.upsert(s.id, { error: String(e.message ?? e) })
        })
      }
    }
  }

  tools(): StructuredToolInterface[] {
    return [...this.live.values()].flatMap((l) => l.tools)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)))
  }
}

export const connectors = new ConnectorService()
