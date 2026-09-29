// Navo as an MCP server: an external MCP client (the official SDK) drives Navo over Streamable HTTP.
import { _electron as electron } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const PORT = 38850
const URL_ = `http://127.0.0.1:${PORT}/mcp`
const home = mkdtempSync(join(tmpdir(), 'ab-home-'))
const mock = startMock(38986)
const app = await electron.launch({ args: ['.'], env: { ...process.env, HOME: home, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const connect = async (token) => {
  const client = new Client({ name: 'e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }))
  return client
}
const callJson = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content?.[0]?.text ?? ''
  if (r.isError) throw new Error(text)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'sk-secret-key' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  await api('mcp.save', {
    name: 'secretive',
    transport: 'http',
    url: 'http://127.0.0.1:1/mcp',
    headers: { Authorization: 'Bearer SHOULD-NOT-LEAK' },
    env: null,
    enabled: false,
  })

  ok(!(await api('navoMcp.status')).running, 'server is off by default')
  await api('settings.set', { mcpServer: { enabled: true, port: PORT, allowRun: true, allowWrite: false } })
  let st = await api('navoMcp.status')
  for (let i = 0; i < 20 && !st.running; i++) {
    await new Promise((r) => setTimeout(r, 100))
    st = await api('navoMcp.status')
  }
  ok(st.running && st.url === URL_, `server listens on loopback (${st.url})`)
  const token = await api('navoMcp.token')

  // auth + origin
  ok((await fetch(URL_, { method: 'POST' })).status === 401, 'requests without a token are rejected')
  ok((await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status === 401, 'wrong token rejected')
  ok(
    (await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status === 403,
    'foreign browser origins rejected (DNS rebinding)',
  )

  // read-only + run
  let client = await connect(token)
  let tools = (await client.listTools()).tools
  const names = tools.map((t) => t.name)
  ok(
    names.includes('navo_list_conversations') && names.includes('navo_send_message') && !names.includes('navo_save_skill'),
    `write tools hidden while "allow write" is off (${names.length} tools)`,
  )
  ok(!names.some((n) => n.startsWith('memory_')), 'memories are not exposed to external agents by default')
  ok(tools.find((t) => t.name === 'navo_list_models')?.annotations?.readOnlyHint === true, 'tools carry MCP read-only annotations')
  const modelsOut = await callJson(client, 'navo_list_models')
  ok(modelsOut[0]?.model === 'mock-1' && !JSON.stringify(modelsOut).includes('sk-secret-key'), 'models listed without API keys')
  const servers = await callJson(client, 'navo_list_mcp_servers')
  ok(
    servers.some((s) => s.name === 'secretive' && s.headerKeys.includes('Authorization')) && !JSON.stringify(servers).includes('SHOULD-NOT-LEAK'),
    'MCP servers listed, header values never exposed',
  )
  ok(Array.isArray(await callJson(client, 'navo_list_skills')) && Array.isArray(await callJson(client, 'navo_list_connectors')), 'skills and connectors listed')

  const sent = await callJson(client, 'navo_send_message', { text: '打开页面并保存', waitSeconds: 60 })
  ok(sent.status === 'completed' && sent.answer?.includes('Hello Agent'), `external agent delegates a task to Navo's agent (${sent.status})`)
  const conv = await callJson(client, 'navo_get_conversation', { conversationId: sent.conversationId })
  ok(
    conv.messages.some((x) => x.role === 'tool' && x.tool === 'browser_navigate'),
    'conversation shows the browser work Navo did',
  )
  ok(
    (await api('threads.list')).some((t) => t.id === sent.conversationId),
    'the delegated conversation appears in the Navo UI',
  )
  const denied = await client.callTool({ name: 'navo_save_skill', arguments: { name: 'x', content: 'y' } })
  ok(denied.isError, 'hidden write tool cannot be called')
  await client.close()

  // write access
  await api('settings.set', { mcpServer: { enabled: true, port: PORT, allowRun: false, allowWrite: true } })
  client = await connect(token)
  tools = (await client.listTools()).tools.map((t) => t.name)
  ok(tools.includes('navo_save_skill') && !tools.includes('navo_send_message'), 'permissions switch tool sets live')
  ok(!tools.some((n) => n.startsWith('memory_')), 'write access alone does not expose memories')
  await api('settings.set', { mcpServer: { enabled: true, port: PORT, allowRun: false, allowWrite: false, allowMemory: true } })
  client = await connect(token)
  tools = (await client.listTools()).tools.map((t) => t.name)
  ok(
    tools.includes('memory_search') && tools.includes('memory_daily') && !tools.includes('memory_save'),
    'opt-in: memories readable, not writable without write access',
  )
  await api('settings.set', { mcpServer: { enabled: true, port: PORT, allowRun: false, allowWrite: true } })
  client = await connect(token)
  await callJson(client, 'navo_save_skill', { name: 'from-mcp', content: '---\nname: from-mcp\ndescription: created over MCP\n---\n# hi\n' })
  ok(
    (await api('skills.list')).some((s) => s.name === 'from-mcp'),
    'skill created over MCP',
  )
  await callJson(client, 'navo_set_default_model', { modelId: m.id })
  let selfErr = ''
  try {
    await callJson(client, 'navo_add_mcp_server', { name: 'loop', transport: 'http', url: URL_ })
  } catch (e) {
    selfErr = e.message
  }
  ok(selfErr.includes('不能再添加到 Navo'), 'Navo refuses to import its own MCP server (no self-calls)')
  await client.close()

  // .agents install + discovery excludes self
  const r = await api('navoMcp.installAgents')
  const written = JSON.parse(readFileSync(join(home, '.agents/mcp.json'), 'utf8'))
  ok(r.path.endsWith('.agents/mcp.json') && written.mcpServers.navo.url === URL_ && existsSync(r.path), 'registered in ~/.agents/mcp.json')
  ok(!(await api('mcp.discover')).some((d) => d.url === URL_), 'discovery does not offer Navo to itself')

  // audit + token rotation
  st = await api('navoMcp.status')
  ok(
    st.calls.some((c) => c.tool === 'navo_send_message' && c.ok) && st.calls.some((c) => c.tool === 'navo_add_mcp_server' && !c.ok),
    'calls are audited (success and failure)',
  )
  const fresh = await api('navoMcp.regenerateToken')
  ok(
    fresh !== token && (await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status === 401,
    'regenerating the token revokes the old one',
  )

  await api('settings.set', { mcpServer: { enabled: false, port: PORT, allowRun: true, allowWrite: false } })
  await new Promise((r) => setTimeout(r, 300))
  ok(
    await fetch(URL_, { method: 'POST' }).then(
      () => false,
      () => true,
    ),
    'disabling stops the server',
  )
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
