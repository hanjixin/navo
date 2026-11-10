// Built-in Pi Core smoke test using the existing offline OpenAI-compatible mock.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
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
  await api('models.setDefault', model.id)
  // New drafts have no explicit model selection even though the composer displays the default.
  for (const runtimeId of ['builtin', 'pi']) {
    const project = await api('projects.save', { name: `Default model ${runtimeId}` })
    const scope = { surface: 'main', projectId: project.id }
    const initial = await api('drafts.get', scope)
    assert.equal(initial.modelId, null)
    const draft = await api('drafts.save', {
      scope,
      text: `[plain] default-model-${runtimeId}`,
      fileIds: [],
      projectFiles: [],
      modelId: null,
      runtimeId,
      expectedVersion: initial.version,
    })
    const receipt = await api('chat.submit', {
      requestId: `default-model-${runtimeId}`,
      runtimeId,
      projectId: project.id,
      text: draft.text,
      draft: { scope, version: draft.version },
    })
    await expect
      .poll(
        async () => (await api('threads.state', receipt.threadId)).messages.some((message) => message.role === 'assistant' && message.content.includes('好的')),
        { timeout: 30_000 },
      )
      .toBe(true)
    await expect.poll(async () => (await api('threads.state', receipt.threadId)).running).toBe(false)
    const savedThread = (await api('threads.list')).find((item) => item.id === receipt.threadId)
    assert.equal(savedThread.modelId, model.id)
    assert.equal(savedThread.runtimeId, runtimeId)
    assert.equal((await api('drafts.get', scope)).text, '')
    assert.ok(mock.requests.some((request) => request.model === 'mock-1' && JSON.stringify(request.messages).includes(`default-model-${runtimeId}`)))
  }
  console.log('PASS builtin/Pi new drafts without modelId capture and run the default model')

  const thread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', thread.id, '[plain] answer through built-in Pi')
  await page.waitForFunction((id) => window.__piEvents.some((event) => event.type === 'run_end' && event.threadId === id), thread.id, { timeout: 20_000 })
  const state = await api('threads.state', thread.id)
  assert.ok(state.messages.some((message) => message.role === 'assistant' && message.content.includes('好的')))
  assert.ok((await page.evaluate(() => window.__piEvents)).some((event) => event.type === 'token'))

  await api('settings.set', { approvalTools: ['browser_navigate'] })
  const approvalThread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', approvalThread.id, '打开页面并告诉我标题')
  await page.waitForFunction((id) => window.__piEvents.some((event) => event.type === 'interrupt' && event.threadId === id), approvalThread.id, {
    timeout: 20_000,
  })
  const pending = await api('threads.state', approvalThread.id)
  assert.equal(pending.interrupt?.actionRequests[0]?.name, 'browser_navigate')
  await api('chat.resume', approvalThread.id, [{ type: 'approve' }])
  await expect
    .poll(
      async () =>
        (await api('threads.state', approvalThread.id)).messages.some(
          (message) => message.role === 'assistant' && message.content.includes('已写入 /workspace/answer.txt'),
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect.poll(async () => (await api('threads.state', approvalThread.id)).running).toBe(false)
  const resumed = await api('threads.state', approvalThread.id)
  assert.equal(resumed.interrupt, null)
  console.log('PASS built-in Pi model mapping, Navo tool bridge, approval pause and resume')

  const cancelledThread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', cancelledThread.id, 'Cancel this navigation at approval')
  await expect
    .poll(async () => (await api('threads.state', cancelledThread.id)).interrupt?.actionRequests[0]?.name, { timeout: 20_000 })
    .toBe('browser_navigate')
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).running).toBe(false)
  const cancelledApproval = (await api('threads.state', cancelledThread.id)).interrupt
  await api('chat.stop', cancelledThread.id)
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).interrupt).toBeNull()
  await assert.rejects(api('chat.resume', cancelledThread.id, [{ type: 'approve' }], [], cancelledApproval.id), /no longer pending/i)
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).running).toBe(false)
  const afterStop = await api('threads.state', cancelledThread.id)
  assert.ok(!afterStop.messages.some((message) => message.role === 'tool' && message.toolName === 'browser_navigate' && message.status === 'success'))
  const continuing = await api('chat.submit', { requestId: 'pi-after-cancel', threadId: cancelledThread.id, text: '[plain] continue after cancelled approval' })
  await expect
    .poll(
      async () => {
        const messages = (await api('threads.state', cancelledThread.id)).messages
        const userIndex = messages.findIndex((message) => message.id === continuing.messageId)
        return userIndex >= 0 && messages.slice(userIndex + 1).some((message) => message.role === 'assistant' && message.content.includes('好的'))
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).running).toBe(false)
  assert.equal((await api('threads.state', cancelledThread.id)).interrupt, null)
  await assert.rejects(api('chat.resume', cancelledThread.id, [{ type: 'approve' }], [], cancelledApproval.id), /no longer pending/i)
  console.log('PASS Pi worker cancellation clears approval, rejects stale resume and allows a fresh message')
} catch (error) {
  console.error('FAIL pi-runtime', error)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  mock.server.close()
}
