import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const mock = startMock(39048)
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'navo-task-lifecycle-')), AB_MEMORY_IDLE_MS: '600000' },
})
const win = await mainWindow(app)
const api = (method, ...args) => win.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
const until = async (fn) => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await win.waitForTimeout(100)
  }
  throw new Error('Timed out waiting for task status')
}
const status = (taskId, runId, expected) => until(async () => (await api('tasks.runs', taskId)).find((run) => run.id === runId && run.status === expected))
try {
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const model = await api('models.save', {
    providerId: provider.id,
    model: 'mock-1',
    displayName: 'Mock',
    supportsTools: true,
    supportsVision: false,
    isDefault: true,
  })
  const task = await api('tasks.save', { name: 'Approval task', prompt: '打开页面并告诉我标题', modelId: model.id, enabled: true, kind: 'agent' })
  await api('settings.set', { approvalTools: ['browser_navigate'] })
  const run = await api('tasks.run', task.id)
  const waiting = await status(task.id, run.id, 'waiting_approval')
  assert.equal(waiting.finishedAt, null)
  assert.equal((await api('tasks.run', task.id)).status, 'skipped')
  await api('chat.resume', run.threadId, [{ type: 'approve' }])
  const completed = await status(task.id, run.id, 'success')
  assert.ok(completed.finishedAt)
  assert.equal((await api('tasks.runs', task.id)).filter((row) => row.status === 'success').length, 1)
  console.log('PASS approval resumes the same task run and overlapping trigger is skipped')

  const stopped = await api('tasks.run', task.id)
  await status(task.id, stopped.id, 'waiting_approval')
  await api('tasks.cancel', stopped.id)
  assert.equal((await status(task.id, stopped.id, 'cancelled')).status, 'cancelled')
  const callsBefore = mock.requests.length
  await assert.rejects(() => api('chat.resume', stopped.threadId, [{ type: 'approve' }]))
  await win.waitForTimeout(300)
  assert.equal(mock.requests.length, callsBefore)
  assert.equal((await api('threads.state', stopped.threadId)).interrupt, null)
  assert.equal((await api('tasks.runs', task.id)).find((row) => row.id === stopped.id).status, 'cancelled')
  console.log('PASS cancellation invalidates old approvals')

  await api('models.setEnabled', model.id, false)
  const failure = await api('tasks.run', task.id)
  const failed = await status(task.id, failure.id, 'error')
  assert.ok(failed.error)
  console.log('PASS disabled model creates visible failed run')

  const macro = await api('macros.save', {
    id: 'cancel-wait',
    name: 'Wait',
    description: '',
    startUrl: '',
    params: [],
    steps: [
      { id: 'wait', type: 'wait', value: '60000' },
      { id: 'navigate', type: 'navigate', url: 'https://example.invalid/should-not-open' },
    ],
    exposeAsTool: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const flow = await api('tasks.save', { name: 'Cancellable flow', prompt: '', enabled: true, kind: 'flow', macroId: macro.id })
  const initialVersions = (await api('flows.versions', macro.id)).length
  const replay = await api('tasks.run', flow.id)
  await win.waitForTimeout(200)
  await api('tasks.cancel', replay.id)
  await status(flow.id, replay.id, 'cancelled')
  await win.waitForTimeout(400)
  assert.equal(
    (await api('browser.state')).tabs.some((tab) => tab.url.includes('should-not-open')),
    false,
  )
  assert.equal((await api('flows.versions', macro.id)).length, initialVersions)
  console.log('PASS cancelling replay wait prevents navigation and repair versions')
} finally {
  await app.close()
  mock.server.close()
}
