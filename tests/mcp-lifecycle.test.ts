import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  clients: [] as { getTools: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
}))
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    constructor() {
      return state.clients.shift()!
    }
  },
}))
vi.mock('../src/main/core/db', () => ({
  db: () => ({
    prepare: (sql: string) => ({
      get: (id: string) => state.rows.get(id),
      all: () => [...state.rows.values()],
      run: (value: string | Record<string, unknown>) => {
        if (sql.startsWith('DELETE')) state.rows.delete(value as string)
        else if (typeof value === 'object') state.rows.set(value.id as string, value)
      },
    }),
  }),
  json: { parse: (v: string | null) => (v ? JSON.parse(v) : null), str: (v: unknown) => JSON.stringify(v ?? null) },
}))
vi.mock('../src/main/core/secrets', () => ({ secrets: { get: () => null, set: vi.fn(), delete: vi.fn() } }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('../src/main/core/shell-env', () => ({ shellPath: () => '/usr/bin' }))
vi.mock('../src/main/mcp/discovery', () => ({ discoverMcp: () => [] }))
vi.mock('../src/main/mcp-server/self', () => ({ isNavoSelfUrl: () => false }))
import { McpService } from '../src/main/mcp/mcp-service'

const input = {
  id: 'server',
  name: 'Test',
  transport: 'http' as const,
  url: 'http://localhost:9000',
  command: null,
  args: null,
  env: null,
  headers: null,
  enabled: true,
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve))
function connection(name = 'tool') {
  let resolve!: (tools: { name: string; description: string }[]) => void
  let reject!: (error: Error) => void
  const client = {
    getTools: vi.fn(
      () =>
        new Promise<{ name: string; description: string }[]>((yes, no) => {
          resolve = yes
          reject = no
        }),
    ),
    close: vi.fn(async () => undefined),
  }
  state.clients.push(client)
  return { client, finish: () => resolve([{ name, description: name }]), fail: () => reject(new Error('connection failed')) }
}
beforeEach(() => {
  state.rows.clear()
  state.clients.length = 0
  state.rows.set('server', { ...input, enabled: 1, args: null })
})
describe('MCP connection lifecycle', () => {
  it.each(['disable', 'delete', 'close'] as const)('closes a connection completing after %s', async (action) => {
    const service = new McpService()
    const pending = connection()
    const connecting = service.reconnect('server')
    await drain()
    if (action === 'disable') await service.save({ ...input, enabled: false })
    if (action === 'delete') await service.delete('server')
    if (action === 'close') await service.closeAll()
    pending.finish()
    await connecting
    expect(service.tools()).toEqual([])
    expect(pending.client.close).toHaveBeenCalledOnce()
    expect(service.status().some((s) => s.state === 'connected')).toBe(false)
  })
  it('keeps the latest saved connection when an older connection finishes last', async () => {
    const service = new McpService()
    const old = connection('old')
    const connecting = service.reconnect('server')
    await drain()
    const latest = connection('latest')
    await service.save({ ...input, url: 'http://localhost:9001' })
    await drain()
    latest.finish()
    await drain()
    old.finish()
    await connecting
    expect(service.tools().map((tool) => tool.name)).toEqual(['latest'])
    expect(old.client.close).toHaveBeenCalledOnce()
    expect(latest.client.close).not.toHaveBeenCalled()
    await service.closeAll()
    expect(latest.client.close).toHaveBeenCalledOnce()
  })
  it('does not publish a stale connection failure over a newer connection', async () => {
    const service = new McpService()
    const old = connection()
    const connecting = service.reconnect('server')
    await drain()
    const latest = connection('latest')
    const reconnecting = service.reconnect('server')
    await drain()
    latest.finish()
    await reconnecting
    old.fail()
    await connecting
    expect(service.status()[0].state).toBe('connected')
    expect(old.client.close).toHaveBeenCalledOnce()
    await service.closeAll()
  })
})
