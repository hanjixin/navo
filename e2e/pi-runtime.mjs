// Built-in Pi Core smoke test using the existing offline OpenAI-compatible mock.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const mock = startMock(39061)
const userData = mkdtempSync(join(tmpdir(), 'navo-pi-core-'))
let app
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData, AB_MEMORY_IDLE_MS: '600000' } })
  const page = await mainWindow(app)
  const api = (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  await page.evaluate(() => {
    window.__piEvents = []
    window.api.on('chat.event', (event) => window.__piEvents.push(event))
  })
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Pi fixture', baseURL: mock.url, apiKey: 'fixture' })
  const model = await api('models.save', {
    providerId: provider.id,
    model: 'mock-1',
    displayName: 'Pi fixture model',
    supportsTools: true,
    supportsVision: false,
    enabled: true,
  })
  const runtime = await api('runtimes.save', { id: 'pi', kind: 'pi', name: 'Pi Coding Agent', enabled: true, command: '', args: [] })
  assert.equal(runtime.profile.enabled, true)
  const thread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', thread.id, '[plain] answer through built-in Pi')
  await page.waitForFunction(() => window.__piEvents.some((event) => event.type === 'run_end'), null, { timeout: 20_000 })
  const state = await api('threads.state', thread.id)
  assert.ok(state.messages.some((message) => message.role === 'assistant' && message.content.includes('好的')))
  assert.ok((await page.evaluate(() => window.__piEvents)).some((event) => event.type === 'token'))

  await api('settings.set', { approvalTools: ['browser_navigate'] })
  const approvalThread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', approvalThread.id, '打开页面并告诉我标题')
  await page.waitForFunction(() => window.__piEvents.some((event) => event.type === 'interrupt'), null, { timeout: 20_000 })
  const pending = await api('threads.state', approvalThread.id)
  assert.equal(pending.interrupt?.actionRequests[0]?.name, 'browser_navigate')
  await api('chat.resume', approvalThread.id, [{ type: 'approve' }])
  await page.waitForFunction(() => window.__piEvents.some((event) => event.type === 'run_end'), null, { timeout: 20_000 })
  const resumed = await api('threads.state', approvalThread.id)
  assert.equal(resumed.interrupt, null)
  console.log('PASS built-in Pi model mapping, Navo tool bridge, approval pause and resume')
} catch (error) {
  console.error('FAIL pi-runtime', error)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  mock.server.close()
}
