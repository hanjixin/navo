import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpServerCall, McpServerStatus } from '@shared/types'
import { clip, NAVO_TOOLS, type ToolDef } from './tools'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { secrets } from '../core/secrets'
import { getSettings } from '../core/settings'

function allowed(def: ToolDef): boolean {
  const { mcpServer: cfg } = getSettings()
  // memories are personal: invisible to external agents unless the user opts in
  if (def.name.startsWith('memory_') && !cfg.allowMemory) return false
  return def.access === 'read' || (def.access === 'write' && cfg.allowWrite) || (def.access === 'run' && cfg.allowRun)
}

class NavoMcpServer {
  private server: Server | null = null
  private port: number | null = null
  private error: string | null = null
  private calls: McpServerCall[] = []

  token(): string {
    let t = secrets.get('navoMcp.token')
    if (!t) {
      t = `navo_${randomBytes(24).toString('base64url')}`
      secrets.set('navoMcp.token', t)
    }
    return t
  }

  regenerateToken(): string {
    secrets.delete('navoMcp.token')
    return this.token()
  }

  url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : null
  }

  status(): McpServerStatus {
    return {
      running: !!this.server,
      url: this.url(),
      error: this.error,
      tools: NAVO_TOOLS.filter(allowed).map((t) => ({ name: t.name, description: t.description, readOnly: t.access === 'read' })),
      calls: this.calls,
    }
  }

  private push(): void {
    emit('navoMcp.status', this.status())
  }

  /** Starts / stops / restarts according to settings. */
  async apply(): Promise<void> {
    const cfg = getSettings().mcpServer
    if (this.server && (!cfg.enabled || this.port !== cfg.port)) await this.stop()
    if (cfg.enabled && !this.server) await this.start(cfg.port)
    this.push()
  }

  private async stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.port = null
    await new Promise<void>((r) => (s ? s.close(() => r()) : r()))
  }

  private start(port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请在设置中更换端口` : err.message
        log.warn(`[navo-mcp] ${this.error}`)
        resolve()
      })
      // loopback only: other machines on the network can never reach it
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        this.port = port
        this.error = null
        log.info(`[navo-mcp] listening on ${this.url()}`)
        resolve()
      })
    })
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? ''
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''))
    const expected = Buffer.from(this.token())
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return void res.writeHead(404).end()
    // Browsers attach Origin; a web page must not be able to drive Navo (DNS rebinding / CSRF)
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return void res.writeHead(403).end('forbidden origin')
    if (!this.authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('unauthorized')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const server = new McpServer(
      { name: 'navo', version: '1.0.0' },
      { instructions: 'Navo desktop agent: conversations, models, skills, MCP servers and connectors on this computer.' },
    )
    for (const def of NAVO_TOOLS.filter(allowed)) {
      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: def.input,
          annotations: { readOnlyHint: def.access === 'read', destructiveHint: !!def.destructive, openWorldHint: def.access === 'run' },
        },
        async (args: Record<string, unknown>) => this.invoke(def, args),
      )
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  }

  private async invoke(def: ToolDef, args: Record<string, unknown>) {
    const started = Date.now()
    const record = (ok: boolean, summary: string) => {
      this.calls = [{ at: started, tool: def.name, ok, ms: Date.now() - started, summary: clip(summary, 160) }, ...this.calls].slice(0, 30)
      this.push()
    }
    try {
      const out = await def.run(args, {})
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
      record(true, def.name === 'navo_send_message' ? String(args.text ?? '') : Object.keys(args).length ? JSON.stringify(args) : '')
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      record(false, message)
      return { isError: true, content: [{ type: 'text' as const, text: message }] }
    }
  }

  /** Registers Navo in the cross-agent ~/.agents/mcp.json (keeps a backup of the previous file). */
  installAgents(): { path: string; backup: string | null } {
    const url = this.url()
    if (!url) throw new Error('请先启用 Navo MCP 服务')
    const path = join(homedir(), '.agents', 'mcp.json')
    mkdirSync(dirname(path), { recursive: true })
    let data: { mcpServers?: Record<string, unknown> } = {}
    let backup: string | null = null
    if (existsSync(path)) {
      data = JSON.parse(readFileSync(path, 'utf8'))
      backup = `${path}.bak-${Date.now()}`
      copyFileSync(path, backup)
    }
    data.mcpServers = { ...(data.mcpServers ?? {}), navo: { type: 'http', url, headers: { Authorization: `Bearer ${this.token()}` } } }
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
    return { path, backup }
  }
}

export const navoMcpServer = new NavoMcpServer()
