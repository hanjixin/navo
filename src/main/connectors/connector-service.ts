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
import { builtinTools, notifyBuiltin, verifyBuiltin } from './builtin'
import { isWriteTool } from './write-tools'
import type { BotMessage } from './builtin/bots'
import { t } from '@shared/i18n'

/** fills {{key}}; null when a placeholder has no value (that arg / env var is left out) */
function fill(template: string, values: Record<string, string>): string | null {
  let missing = false
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = values[k]?.trim()
    if (!v) missing = true
    return v ?? ''
  })
  return missing ? null : out
}

interface Row {
  id: string
  connected: number
  enabled: number
  connected_at: number | null
  error: string | null
  custom_def: string | null
  /** non-secret field values (JSON) */
  config: string | null
}

type Live = { tools: StructuredToolInterface[]; close: () => Promise<void> }

/** The built-in definitions in the interface language (the user's own connectors are shown as written). */
function translated(d: ConnectorDef): ConnectorDef {
  const o = (v?: string) => (v ? t(v) : v)
  return {
    ...d,
    name: t(d.name),
    description: t(d.description),
    fields: d.fields?.map((f) => ({
      ...f,
      label: t(f.label),
      help: o(f.help),
      placeholder: o(f.placeholder),
      options: f.options?.map((x) => ({ ...x, label: t(x.label) })),
    })),
  }
}

class ConnectorService {
  private live = new Map<string, Live>()

  catalog(): ConnectorDef[] {
    const custom = (db().prepare('SELECT custom_def FROM connectors WHERE custom_def IS NOT NULL').all() as Row[])
      .map((r) => json.parse<ConnectorDef>(r.custom_def))
      .filter((d): d is ConnectorDef => !!d)
    return [...CATALOG.map(translated), ...custom]
  }

  def(id: string): ConnectorDef {
    const d = this.catalog().find((c) => c.id === id)
    if (!d) throw new Error(t('未知连接器: {{v0}}', { v0: id }))
    return d
  }

  private row(id: string): Row | undefined {
    return db().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Row | undefined
  }

  private upsert(id: string, patch: Partial<Omit<Row, 'id'>>): void {
    const cur = this.row(id) ?? { id, connected: 0, enabled: 1, connected_at: null, error: null, custom_def: null, config: null }
    const next = { ...cur, ...patch }
    db()
      .prepare(
        `INSERT INTO connectors(id, connected, enabled, connected_at, error, custom_def, config) VALUES(@id, @connected, @enabled, @connected_at, @error, @custom_def, @config)
         ON CONFLICT(id) DO UPDATE SET connected=@connected, enabled=@enabled, connected_at=@connected_at, error=@error, custom_def=@custom_def, config=@config`,
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
        config: json.parse<Record<string, string>>(r?.config ?? null) ?? undefined,
      }
    })
  }

  private state(id: string): ConnectorState {
    return this.states().find((s) => s.id === id)!
  }

  /** A form connector's values: the stored non-secret ones plus secrets from the keychain. */
  private values(def: ConnectorDef): Record<string, string> {
    const config = json.parse<Record<string, string>>(this.row(def.id)?.config ?? null) ?? {}
    const out: Record<string, string> = {}
    for (const f of def.fields ?? []) {
      const v = f.secret ? secrets.get(`connector:${def.id}:${f.key}`) : config[f.key]
      if (v ?? f.default) out[f.key] = v ?? f.default!
    }
    return out
  }

  /** Stores a form's values: secrets in the keychain (kept when left blank on a reconnect), the rest in the database. */
  private saveValues(def: ConnectorDef, input: Record<string, string>): void {
    const config: Record<string, string> = {}
    for (const f of def.fields ?? []) {
      const v = input[f.key]?.trim() ?? ''
      const hidden = f.showIf && !f.showIf.values.includes(input[f.showIf.key] ?? this.values(def)[f.showIf.key] ?? '')
      if (f.secret) {
        const key = `connector:${def.id}:${f.key}`
        if (v) secrets.set(key, v)
        else if (f.optional && input[f.key] !== undefined) secrets.delete(key)
        if (!f.optional && !hidden && !secrets.has(key)) throw new Error(t('请填写{{v0}}', { v0: f.label }))
      } else {
        const val = v || f.default || ''
        if (!val && !f.optional && !hidden) throw new Error(t('请填写{{v0}}', { v0: f.label }))
        if (val) config[f.key] = val
      }
    }
    this.upsert(def.id, { config: JSON.stringify(config) })
  }

  async connect(id: string, credentials?: string | Record<string, string>): Promise<ConnectorState> {
    const def = this.def(id)
    const token = typeof credentials === 'string' ? credentials : undefined
    if (def.auth === 'fields') {
      try {
        this.saveValues(def, typeof credentials === 'object' ? credentials : {})
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
    if (!def.mcpUrl) throw new Error(t('该连接器缺少 MCP 地址'))
    try {
      if (def.auth === 'token') {
        if (!token && !secrets.has(`connector:${id}`)) throw new Error(t('请填写 {{v0}}', { v0: def.tokenLabel ?? 'Token' }))
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
    if (def.kind === 'builtin' && def.builtin) {
      const values = this.values(def)
      await verifyBuiltin(def.builtin, values)
      this.live.set(def.id, { tools: builtinTools(def.builtin, values, values.name ?? ''), close: async () => undefined })
      log.info(`[connector] ${def.id} ready (built in)`)
      return
    }
    if (def.kind === 'stdio' && def.stdio) {
      const values = this.values(def)
      const args = def.stdio.args.map((a) => fill(a, values)).filter((a): a is string => a !== null)
      const env = Object.fromEntries(
        Object.entries(def.stdio.env ?? {})
          .map(([k, t]) => [k, fill(t, values)] as const)
          .filter((e): e is readonly [string, string] => e[1] !== null),
      )
      const conn = await connectEndpoint({ name: def.id, transport: 'stdio', command: def.stdio.command, args, env })
      this.live.set(def.id, { tools: conn.tools, close: () => conn.client.close() })
      log.info(`[connector] ${def.id} ready with ${conn.tools.length} tools`)
      return
    }
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
    for (const f of this.def(id).fields ?? []) if (f.secret) secrets.delete(`connector:${id}:${f.key}`)
    new StoredOAuthProvider(id).clear()
    this.upsert(id, { connected: 0, connected_at: null, error: null })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.upsert(id, { enabled: enabled ? 1 : 0 })
    if (!enabled) await this.stop(id)
    else if (this.row(id)?.connected) await this.start(this.def(id)).catch((e) => this.upsert(id, { error: String(e.message ?? e) }))
  }

  addCustom(input: Omit<ConnectorDef, 'id' | 'custom' | 'icon'>): ConnectorDef {
    if (!input.name.trim() || !input.mcpUrl) throw new Error(t('名称和 MCP 地址必填'))
    if (isNavoSelfUrl(input.mcpUrl)) throw new Error(t('这是 Navo 自己对外提供的 MCP 服务，不能作为连接器添加'))
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

  /** Sends a message through a connected group bot / mailbox (monitor alerts, test messages). */
  async notify(id: string, msg: BotMessage): Promise<void> {
    const def = this.def(id)
    const s = this.state(id)
    if (!def.canNotify || !def.builtin) throw new Error(t('{{v0}} 不能接收通知', { v0: def.name }))
    if (!s.connected || !s.enabled) throw new Error(t('{{v0}} 没有连接', { v0: def.name }))
    await notifyBuiltin(def.builtin, this.values(def), msg)
  }

  testNotify(id: string): Promise<void> {
    return this.notify(id, {
      title: t('Navo 测试消息'),
      text: t('连接正常。之后网页监控的提醒等可以发到这里。\n\n{{v0}}', { v0: new Date().toLocaleString('zh-CN') }),
    })
  }

  /**
   * Tools of the office connectors that change something (send a message, create / delete a
   * document or event…): they pause for approval like the built-in send tools.
   */
  writeTools(): string[] {
    const office = new Set(
      this.catalog()
        .filter((d) => d.group === 'office-cn')
        .map((d) => d.id),
    )
    return [...this.live]
      .filter(([id]) => office.has(id))
      .flatMap(([, l]) => l.tools.map((t) => t.name))
      .filter(isWriteTool)
  }

  tools(): StructuredToolInterface[] {
    return [...this.live.values()].flatMap((l) => l.tools)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)))
  }
}

export const connectors = new ConnectorService()
