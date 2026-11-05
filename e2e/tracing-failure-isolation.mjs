// Corrupted optional tracing credentials must not prevent the app or ordinary chat from starting.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-tracing-failure-'))
const database = new DatabaseSync(join(profile, 'agent.db'))
const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
const migrations = [...source.matchAll(/`([\s\S]*?)`/g)].map((match) => match[1])
for (const sql of migrations) database.exec(sql)
database.exec(`PRAGMA user_version=${migrations.length}`)
const damaged = Buffer.from('invalid encrypted secret fixture').toString('base64')
for (const key of ['langsmith', 'langfuse.secret']) database.prepare('INSERT INTO secrets(key,value) VALUES(?,?)').run(key, damaged)
database.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run(
  'settings',
  JSON.stringify({
    onboarded: true,
    devMode: true,
    memory: { enabled: false, autoLearn: false },
    langfuse: { enabled: true, publicKey: 'pk-fixture', baseUrl: 'http://127.0.0.1:9' },
  }),
)
database.close()
const mock = startMock(39049)
let app
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile } })
  const page = await mainWindow(app)
  const api = (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  const status = await api('settings.integrationStatus')
  assert.equal(status.langsmith.state, 'error')
  assert.equal(status.langfuse.state, 'error')
  assert.ok(!JSON.stringify(status).includes(damaged))
  console.log('PASS app boots and exposes safe reconfiguration diagnostics with two corrupted keys')
  assert.equal((await api('langfuse.test')).ok, false)
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const model = await api('models.save', { providerId: provider.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, enabled: true })
  const thread = await api('threads.create', model.id)
  await api('chat.send', thread.id, '[plain] 仍然可以正常聊天')
  const deadline = Date.now() + 30000
  let completed = false
  while (Date.now() < deadline) {
    const state = await api('threads.state', thread.id)
    if (!state.running && state.messages.some((message) => message.role === 'assistant' && message.content)) {
      completed = true
      break
    }
    await page.waitForTimeout(100)
  }
  assert.ok(completed, 'ordinary conversation completes without optional tracing')
  console.log('PASS ordinary chat works while optional tracing credentials remain unusable')
  await api('settings.set', { devMode: false, langfuse: { ...(await api('settings.get')).langfuse, enabled: false } })
  assert.deepEqual(await api('settings.integrationStatus'), { langsmith: { state: 'disabled' }, langfuse: { state: 'disabled' } })
  await app.close()
  app = null
  const check = new DatabaseSync(join(profile, 'agent.db'))
  assert.equal(check.prepare('SELECT value FROM secrets WHERE key=?').get('langfuse.secret').value, damaged)
  assert.equal(check.prepare('SELECT value FROM secrets WHERE key=?').get('langsmith').value, damaged)
  check.close()
  console.log('PASS disabling tracing preserves both original encrypted records')
} finally {
  if (app) await app.close()
  mock.server.close()
  rmSync(profile, { recursive: true, force: true })
}
