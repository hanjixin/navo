// Real renderer persistence and durable submission acceptance in an isolated profile.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-drafts-'))
const mock = startMock(39051)
let app, page
const launch = async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  page = await mainWindow(app)
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false)
      win.setFocusable(false)
      win.setIgnoreMouseEvents(true)
    }
  })
}
const api = (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
const route = (path) =>
  page.evaluate((path) => {
    window.location.hash = path
  }, path)
const input = () => page.locator('main textarea').last()
try {
  await launch()
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Draft fixture', baseURL: mock.url, apiKey: 'fixture' })
  const model = await api('models.save', {
    providerId: provider.id,
    model: 'mock-1',
    displayName: 'Mock',
    supportsTools: true,
    supportsVision: false,
    enabled: true,
  })
  const a = await api('projects.save', { name: 'Draft A' }),
    b = await api('projects.save', { name: 'Draft B' })
  const scopeA = { surface: 'main', projectId: a.id },
    scopeB = { surface: 'main', projectId: b.id }
  await route(`/projects/${a.id}`)
  await expect(input()).toBeEnabled()
  await input().fill('A survives navigation')
  await route(`/projects/${b.id}`)
  await expect(input()).toBeEnabled()
  await expect(input()).toHaveValue('')
  await input().fill('B stays separate')
  await route(`/projects/${a.id}`)
  await expect(input()).toHaveValue('A survives navigation')
  assert.equal((await api('drafts.get', scopeB)).text, 'B stays separate')

  // Unload must flush the final keystrokes, without relying on the debounce timer.
  await input().fill('A survives immediate close')
  await app.close()
  await launch()
  await route(`/projects/${a.id}`)
  await expect(input()).toHaveValue('A survives immediate close')

  // A rejected attachment cannot erase the draft or create an empty conversation.
  const before = await api('drafts.get', scopeA)
  await api('drafts.save', { ...before, editorId: undefined, editRevision: undefined, fileIds: ['missing-file'], expectedVersion: before.version })
  await page.reload()
  await expect(input()).toHaveValue('A survives immediate close')
  const threadsBefore = (await api('threads.list')).length
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('提交失败', { exact: true })).toBeVisible()
  await expect(input()).toHaveValue('A survives immediate close')
  assert.equal((await api('threads.list')).length, threadsBefore)
  assert.deepEqual((await api('drafts.get', scopeA)).fileIds, ['missing-file'])

  const current = await api('drafts.get', scopeA)
  await api('drafts.save', {
    ...current,
    editorId: undefined,
    editRevision: undefined,
    text: '[plain] accepted once',
    fileIds: [],
    modelId: model.id,
    expectedVersion: current.version,
  })
  await page.reload()
  await expect(input()).toHaveValue('[plain] accepted once')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.url()).toContain(`/projects/${a.id}/chat/`)
  await expect(input()).toHaveValue('')
  assert.equal((await api('drafts.get', scopeA)).text, '')

  const request = { requestId: 'drafts-idempotent-test', projectId: b.id, modelId: model.id, text: '[plain] same request' }
  const [one, two] = await Promise.all([api('chat.submit', request), api('chat.submit', request)])
  assert.deepEqual(one, two)
  await expect.poll(async () => (await api('threads.state', one.threadId)).running).toBe(false)
  const state = await api('threads.state', one.threadId)
  assert.equal(state.messages.filter((m) => m.id === one.messageId).length, 1)
  assert.deepEqual(await api('chat.submit', request), one)
  await assert.rejects(api('chat.submit', { ...request, text: 'different' }), /different content/)

  // Main and quick drafts remain independent; explicit transfer never overwrites the main one.
  await route('/chat')
  await expect(input()).toBeEnabled()
  await input().fill('Main window draft')
  await expect.poll(async () => (await api('drafts.get', { surface: 'main' })).text).toBe('Main window draft')
  await api('quick.show')
  const quick = await expect
    .poll(() => app.windows().some((win) => win.url().includes('#/quick')))
    .toBe(true)
    .then(() => app.windows().find((win) => win.url().includes('#/quick')))
  await expect(quick.locator('textarea')).toBeEnabled()
  await quick.locator('textarea').fill('Quick draft')
  await quick.getByRole('button', { name: '在 Navo 中继续', exact: true }).click()
  await expect(input()).toHaveValue('Main window draft')
  assert.equal((await api('drafts.get', { surface: 'quick' })).text, 'Quick draft')
  await input().fill('')
  await api('quick.show')
  await quick.getByRole('button', { name: '在 Navo 中继续', exact: true }).click()
  await expect(input()).toHaveValue('Quick draft')
  await expect.poll(async () => (await api('drafts.get', { surface: 'quick' })).text).toBe('')
  console.log('PASS draft scope, unload persistence, rejected send preservation, durable idempotency and quick transfer conflict')
} catch (e) {
  console.error(`FAIL chat-drafts (${profile})`, e)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  mock.server.close()
}
