import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ToolDescriptor } from './contracts'
import type { RuntimeToolDispatcher } from './types'

/** Private, short-lived MCP endpoint. It never exposes the global management server. */
export async function createRuntimeMcpBridge(options: {
  tools: ToolDescriptor[]
  dispatcher: RuntimeToolDispatcher
  signal: AbortSignal
}): Promise<{ url: string; token: string; close(): Promise<void> }> {
  if (options.signal.aborted) throw new Error('Runtime stopped')
  const token = randomBytes(32).toString('base64url')
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  const connections = new Set<McpServer>()
  let closed = false
  let port = 0
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (closed || options.signal.aborted) return void res.writeHead(410).end()
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin) return void res.writeHead(403).end()
    if (req.url !== '/mcp') return void res.writeHead(404).end()
    const given = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return void res.writeHead(401).end()
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end()
    let length = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk)
      if (length > 1024 * 1024) return void res.writeHead(413).end()
      chunks.push(Buffer.from(chunk))
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return void res.writeHead(400).end('Invalid JSON')
    }
    if (closed || options.signal.aborted) return void res.writeHead(410).end()
    const notification = body as { method?: string; params?: { requestId?: string | number } } | null
    if (notification?.method === 'notifications/cancelled') {
      const requestId = notification.params?.requestId
      if (typeof requestId === 'string' || typeof requestId === 'number') options.dispatcher.cancel?.(`mcp:${requestId}`)
      return void res.writeHead(202).end()
    }
    const server = new McpServer({ name: 'navo-runtime', version: '1.0.0' }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    connections.add(server)
    let callId: string | undefined
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema as { type: 'object' } })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (closed || options.signal.aborted) throw new Error('Runtime stopped')
      if (!tools.has(request.params.name)) throw new Error('Unknown Navo tool')
      callId = `mcp:${String(extra.requestId)}`
      const result = await options.dispatcher.call({ id: callId, name: request.params.name, args: request.params.arguments ?? {} })
      return { ...result }
    })
    res.on('close', () => {
      if (!res.writableEnded && callId) options.dispatcher.cancel?.(callId)
      connections.delete(server)
      void server.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('Runtime bridge request failed')
      else res.end()
    })
  })
  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    closed = true
    options.signal.removeEventListener('abort', onAbort)
    closing = (async () => {
      await Promise.allSettled([...connections].map((server) => server.close()))
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    })()
    return closing
  }
  const onAbort = () => void close()
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.removeListener('error', reject)
      const address = http.address()
      if (!address || typeof address === 'string') return reject(new Error('MCP bridge failed to listen'))
      port = address.port
      resolve()
    })
  })
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) {
    await close()
    throw new Error('Runtime stopped')
  }
  return { url: `http://127.0.0.1:${port}/mcp`, token, close }
}
