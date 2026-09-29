import { getSettings } from '../core/settings'

/** True when `url` points at Navo's own MCP server; importing it into Navo would let the agent call itself. */
export function isNavoSelfUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && port === getSettings().mcpServer.port && u.pathname.replace(/\/+$/, '') === '/mcp'
  } catch {
    return false
  }
}
