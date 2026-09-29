// Stateless Streamable-HTTP MCP server that requires a bearer token.
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export function startHttpMcp(port, token) {
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end('unauthorized')
    let body = ''
    for await (const c of req) body += c
    const mcp = new McpServer({ name: 'notes', version: '1.0.0' })
    mcp.registerTool('get_note', { description: 'Read a note', inputSchema: { id: z.string() } }, async ({ id }) => ({
      content: [{ type: 'text', text: `note ${id}: remember the milk` }],
    }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  })
  server.listen(port)
  return { server, url: `http://127.0.0.1:${port}/mcp` }
}
