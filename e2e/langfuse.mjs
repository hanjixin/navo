// Langfuse integration against a local fake Langfuse (projects API + OTLP ingestion).
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMock } from './mock-llm.mjs'

const PK = 'pk-lf-test'
const SK = 'sk-lf-test'
const ingested = []
const lf = createServer(async (req, res) => {
  const auth = req.headers.authorization ?? ''
  const okAuth = auth === `Basic ${Buffer.from(`${PK}:${SK}`).toString('base64')}`
  let body = Buffer.alloc(0)
  for await (const c of req) body = Buffer.concat([body, c])
  if (req.url.startsWith('/api/public/projects')) {
    if (!okAuth) return res.writeHead(401).end()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'proj_123', name: 'Navo Test' }] }))
  }
  if (req.url.includes('/otel/v1/traces')) {
    ingested.push({ okAuth, body: body.toString('utf8') })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end('{}')
  }
  res.writeHead(404).end()
}).listen(38992)

const mock = startMock(38991)
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
await page.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})
const runAndWait = async (threadId, text) => {
  const from = (await page.evaluate(() => window.__events)).length
  await api('chat.send', threadId, text)
  for (let i = 0; i < 80; i++) {
    const evs = (await page.evaluate(() => window.__events)).slice(from)
    const end = evs.find((e) => e.type === 'run_end' && e.threadId === threadId)
    if (end) return end
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: true })

  await api('settings.set', {
    langfuse: { enabled: false, baseUrl: 'http://127.0.0.1:38992', publicKey: PK, environment: 'test', includeScreenshots: false },
    langfuseSecretKey: 'wrong',
  })
  ok(!(await api('langfuse.test')).ok, 'wrong secret key is rejected by the connection test')
  await api('settings.set', { langfuseSecretKey: SK })
  const t = await api('langfuse.test')
  ok(t.ok && t.projectId === 'proj_123', 'connection test succeeds and resolves the project')
  const s = await api('settings.get')
  ok(s.langfuse.secretKeySet && !JSON.stringify(s).includes(SK), 'secret key stored in keychain, never returned to the UI')

  // disabled → nothing sent
  const t0 = await api('threads.create', m.id)
  await runAndWait(t0.id, '[plain] 不追踪')
  ok(ingested.length === 0, 'no traces while Langfuse is disabled')

  await api('settings.set', { langfuse: { ...s.langfuse, enabled: true } })
  const th = await api('threads.create', m.id)
  const end = await runAndWait(th.id, '打开页面并保存')
  await new Promise((r) => setTimeout(r, 500))
  const all = ingested.map((x) => x.body).join('')
  ok(ingested.length > 0 && ingested.every((x) => x.okAuth), `spans exported with basic auth (${ingested.length} request(s))`)
  ok(all.includes(th.id), 'trace carries the conversation id as session')
  ok(all.includes('browser_navigate') && all.includes('mock-1'), 'tool calls and model generations are traced')
  ok(all.includes('test'), 'environment attribute exported')
  ok(end?.traceUrl?.startsWith('http://127.0.0.1:38992/project/proj_123/traces/'), `run_end carries a trace link (${end?.traceUrl})`)

  const before = ingested.length
  const ts = await api('threads.create', m.id)
  await runAndWait(ts.id, '[shot] 截个图')
  await new Promise((r) => setTimeout(r, 500))
  const shotBody = ingested
    .slice(before)
    .map((x) => x.body)
    .join('')
  ok(
    shotBody.includes('browser_screenshot') && !/data:image\/jpeg;base64,[A-Za-z0-9+/]{200}/.test(shotBody) && shotBody.includes('截图已省略'),
    'screenshots masked in exported traces by default',
  )
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  lf.close()
}
