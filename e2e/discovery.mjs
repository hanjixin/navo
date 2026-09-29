// External skill sources (.agents etc.) + MCP / connector discovery, against a fake HOME.
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startMock } from './mock-llm.mjs'
import { startHttpMcp } from './fixtures/mcp-http.mjs'

const home = mkdtempSync(join(tmpdir(), 'ab-home-'))
const w = (p, c) => (mkdirSync(join(home, p, '..'), { recursive: true }), writeFileSync(join(home, p), c))
const skill = (dir, name, desc) => w(`${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`)

skill('.agents/skills/alpha-skill', 'alpha-skill', 'Alpha from agents')
skill('.agents/skills/beta-skill', 'beta-skill', 'Beta from agents')
skill('pack/skills/gamma-skill', 'gamma-skill', 'Gamma in a symlinked collection')
skill('pack/skills/delta-skill', 'delta-skill', 'Delta in a symlinked collection')
symlinkSync(join(home, 'pack/skills'), join(home, '.agents/skills/pack'))
w('.agents/.skill-lock.json', JSON.stringify({ version: 3, skills: { 'alpha-skill': { source: 'acme/skills' } } }))
mkdirSync(join(home, '.claude/skills'), { recursive: true })
symlinkSync(join(home, '.agents/skills/alpha-skill'), join(home, '.claude/skills/alpha-skill')) // duplicate via symlink
skill('.claude/skills/claude-only', 'claude-only', 'Only in Claude Code')

const http = startHttpMcp(38996, 'sekret')
const stdioScript = resolve('e2e/fixtures/mcp-stdio.mjs')
w(
  '.claude.json',
  JSON.stringify({
    mcpServers: { calc: { command: process.execPath, args: [stdioScript] } },
    projects: { '/tmp/proj': { mcpServers: { 'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' } } } },
  }),
)
w('.agents/mcp.json', JSON.stringify({ mcpServers: { notes: { type: 'http', url: http.url, headers: { Authorization: 'Bearer sekret' } } } }))
w(
  '.codex/config.toml',
  `[mcp_servers.calc]\ncommand = "${process.execPath}"\nargs = ["${stdioScript}"]\n\n[mcp_servers.fetch]\ncommand = "uvx"\nargs = ["mcp-server-fetch"]\n[mcp_servers.fetch.env]\nFOO = "bar"\n`,
)

const mock = startMock(38995)
const app = await electron.launch({ args: ['.'], env: { ...process.env, HOME: home, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const waitRun = async () => {
  for (let i = 0; i < 60; i++) {
    if ((await page.evaluate(() => window.__events)).some((e) => e.type === 'run_end')) return
    await page.waitForTimeout(500)
  }
}
await page.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})

try {
  // ---- skills
  const sources = await api('skills.sources')
  const count = (id) => sources.find((s) => s.id === id)?.skillCount
  ok(count('agents') === 4 && count('claude') === 1, `sources scanned (.agents=${count('agents')}, claude=${count('claude')})`)
  let list = await api('skills.list')
  const names = list.map((s) => s.name)
  ok(
    ['alpha-skill', 'beta-skill', 'gamma-skill', 'delta-skill', 'claude-only'].every((n) => names.includes(n)),
    'skills from direct folders + symlinked collection',
  )
  ok(names.filter((n) => n === 'alpha-skill').length === 1, 'symlinked duplicate across sources shown once')
  ok(list.find((s) => s.name === 'alpha-skill')?.origin === 'acme/skills', 'origin read from .skill-lock.json')
  ok(
    list.every((s) => s.source === 'local' || s.readOnly),
    'external skills are read-only',
  )
  const beta = list.find((s) => s.name === 'beta-skill')
  await api('skills.setEnabled', beta.id, false)
  ok((await api('skills.read', list.find((s) => s.name === 'gamma-skill').id)).includes('Gamma'), 'read external skill content')

  const p = await api('providers.save', { type: 'openai-compatible', name: 'mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  const t = await api('threads.create', m.id)
  await api('chat.send', t.id, '[plain] hi')
  await waitRun()
  const sys = JSON.stringify(mock.requests.at(-1).messages[0].content)
  ok(
    ['alpha-skill', 'gamma-skill', 'claude-only'].every((n) => sys.includes(n)),
    'agent system prompt lists external skills',
  )
  ok(!sys.includes('beta-skill'), 'disabled external skill hidden from agent')

  const local = await api('skills.copyToLocal', list.find((s) => s.name === 'alpha-skill').id)
  list = await api('skills.list')
  ok(local.source === 'local' && list.find((s) => s.source !== 'local' && s.name === 'alpha-skill')?.shadowed, 'copy to local shadows the external one')
  let threw = false
  try {
    await api('skills.save', list.find((s) => s.name === 'gamma-skill').id, 'x')
  } catch {
    threw = true
  }
  ok(threw, 'saving an external skill is refused')

  // ---- MCP discovery
  const found = await api('mcp.discover')
  const byName = (n) => found.filter((d) => d.name === n)
  ok(byName('calc').length === 1, 'same stdio server in two tools collapsed into one')
  ok(byName('linear-server')[0]?.connectorId === 'linear', 'remote server matched to built-in Linear connector')
  ok(byName('notes')[0]?.sourceLabel === '.agents' && byName('notes')[0].headers?.Authorization, '.agents/mcp.json read with headers')
  ok(byName('fetch')[0]?.env?.FOO === 'bar' && byName('fetch')[0].sourceLabel === 'Codex', 'Codex TOML parsed incl. env table')
  ok(
    found.some((d) => d.sourceLabel.startsWith('Claude Code · ')),
    'Claude Code project-level servers included',
  )

  const imported = await api('mcp.importDiscovered', [byName('calc')[0].key])
  ok(imported.length === 1, 'import discovered stdio server')
  let st = []
  for (let i = 0; i < 30; i++) {
    st = await api('mcp.status')
    if (st.some((s) => s.state === 'connected' || s.state === 'error')) break
    await page.waitForTimeout(300)
  }
  ok(st[0]?.state === 'connected' && st[0].tools.some((x) => x.name.includes('add')), `imported server connects (${st[0]?.state} ${st[0]?.error ?? ''})`)
  ok((await api('mcp.discover')).find((d) => d.name === 'calc')?.imported, 'discovery marks it imported')

  await page.evaluate(() => (window.__events = []))
  const t2 = await api('threads.create', m.id)
  await api('chat.send', t2.id, '[mcp] 2+3')
  await waitRun()
  const s2 = await api('threads.state', t2.id)
  ok(s2.messages.at(-1)?.content.includes('5'), `agent calls MCP tool end-to-end (${s2.messages.at(-1)?.content})`)

  // ---- connector from discovered remote server with bearer token
  const notes = byName('notes')[0]
  const def = await api('connectors.addCustom', { name: notes.name, description: 'x', mcpUrl: notes.url, auth: 'token', tokenLabel: 'Bearer Token' })
  const cs = await api('connectors.connect', def.id, 'sekret')
  const tools = await api('dev.tools')
  ok(cs.connected && tools.some((x) => x.source === 'connector' && x.name.includes('get_note')), 'discovered remote server added as token connector')
  let bad = false
  try {
    const d2 = await api('connectors.addCustom', { name: 'wrong', description: 'x', mcpUrl: notes.url, auth: 'token', tokenLabel: 'T' })
    await api('connectors.connect', d2.id, 'nope')
  } catch {
    bad = true
  }
  ok(bad, 'wrong token is rejected with an error')
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  http.server.close()
}
