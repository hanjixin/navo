// Custom model combobox uses an isolated profile and a local provider, never real credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-model-picker-'))
const ids = Array.from({ length: 27 }, (_, index) => `fixture-model-${String(index + 1).padStart(2, '0')}`)
let responseModels = ids
let fail = false
let hold = false
let pendingResponse
let requestCount = 0
const send = (response) => {
  response.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(fail ? { error: { message: 'Fixture model list unavailable' } } : { data: responseModels.map((id) => ({ id })) }))
}
const server = createServer((request, response) => {
  if (request.method !== 'GET' || !request.url.endsWith('/models')) {
    response.writeHead(404).end()
    return
  }
  requestCount++
  if (hold) pendingResponse = response
  else send(response)
})
server.listen(0, '127.0.0.1')
let app
try {
  await once(server, 'listening')
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  const win = await mainWindow(app)
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
    }
  })
  const api = (method, ...args) => win.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  const provider = await api('providers.save', {
    type: 'openai-compatible',
    name: 'Picker fixture provider',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'fixture-only',
  })
  await win.evaluate(() => {
    window.location.hash = '/models'
  })
  const dialog = win.getByRole('dialog')
  const input = dialog.getByRole('combobox', { name: '模型 ID', exact: true })
  const list = dialog.getByRole('listbox', { name: '可用模型', exact: true })
  const add = async () => {
    await win.locator('main').getByRole('button', { name: '添加模型', exact: true }).first().click()
    await expect(dialog).toBeVisible()
  }
  const fetchModels = async () => {
    await dialog.getByRole('button', { name: '从接口拉取可用模型', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '从接口拉取可用模型', exact: true })).toBeEnabled()
  }
  const expand = async () => {
    const close = dialog.getByRole('button', { name: '收起模型列表', exact: true })
    if (await close.isVisible()) await close.click()
    await dialog.getByRole('button', { name: '展开模型列表', exact: true }).click()
    await expect(list).toBeVisible()
  }
  const save = async () => {
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  await add()
  await fetchModels()
  await expand()
  await expect(list.getByRole('option')).toHaveCount(27)
  const evidence = join(process.cwd(), '.superpowers/sdd/2026-11-04-workspace-improvements')
  mkdirSync(evidence, { recursive: true })
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('index.html'))
        .webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    )
      .toPNG()
      .toString('base64'),
  )
  writeFileSync(join(evidence, 'model-picker.png'), Buffer.from(png, 'base64'))

  await list.getByRole('option', { name: ids[19], exact: true }).click()
  await expect(input).toHaveValue(ids[19])
  await save()
  let saved = (await api('models.list')).find((model) => model.providerId === provider.id)
  assert.equal(saved.model, ids[19])

  // Editing a complete ID still exposes other options and saves the same record.
  const row = win.getByTestId('model-row').filter({ has: win.getByText(ids[19], { exact: true }) })
  await row.getByRole('button', { name: '更多', exact: true }).click()
  await win.getByRole('menuitem', { name: '编辑', exact: true }).click()
  await expect(input).toHaveValue(ids[19])
  await fetchModels()
  await expand()
  await expect(list.getByRole('option')).toHaveCount(27)
  await list.getByRole('option', { name: ids[23], exact: true }).click()
  await save()
  assert.equal((await api('models.list')).find((model) => model.id === saved.id).model, ids[23])

  // Search, keyboard selection, and Escape operate inside the dialog.
  await add()
  await fetchModels()
  await input.fill('model-2')
  await expect(list.getByRole('option')).toHaveCount(8)
  await input.press('ArrowDown')
  const activeId = await input.getAttribute('aria-activedescendant')
  assert.ok(activeId)
  const selected = await win.locator(`[id="${activeId}"]`).textContent()
  await input.press('Enter')
  await expect(input).toHaveValue(selected.trim())
  await expect(dialog).toBeVisible()
  await expect(list).toBeHidden()
  await expand()
  await input.press('Escape')
  await expect(list).toBeHidden()
  await expect(dialog).toBeVisible()
  await input.fill('my-manual-model')
  await expect(list.getByRole('option')).toHaveCount(0)
  await save()
  assert.ok((await api('models.list')).some((model) => model.model === 'my-manual-model'))

  responseModels = []
  await add()
  await fetchModels()
  await expect(dialog).toContainText('无法获取模型列表')
  await input.fill('manual-empty-provider')
  await save()
  assert.ok((await api('models.list')).some((model) => model.model === 'manual-empty-provider'))

  fail = true
  await add()
  await fetchModels()
  await expect(dialog.getByRole('alert')).toContainText('无法获取模型列表')
  await input.fill('manual-failed-provider')
  await save()
  assert.ok((await api('models.list')).some((model) => model.model === 'manual-failed-provider'))

  // A delayed successful response cannot overwrite a value typed during the request.
  fail = false
  hold = true
  responseModels = ids.slice(0, 3)
  await add()
  const before = requestCount
  await dialog.getByRole('button', { name: '从接口拉取可用模型', exact: true }).click()
  await expect.poll(() => requestCount).toBe(before + 1)
  await input.fill('typed-while-fetching')
  hold = false
  send(pendingResponse)
  pendingResponse = undefined
  await expect(dialog.getByRole('button', { name: '从接口拉取可用模型', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('typed-while-fetching')
  await expand()
  await expect(list.getByRole('option')).toHaveCount(3)
  await save()
  assert.ok((await api('models.list')).some((model) => model.model === 'typed-while-fetching'))
  console.log('PASS model picker: 27 remote options, edit existing ID, keyboard search, Escape, manual input, empty/error and delayed response')
} catch (error) {
  console.error(`FAIL model-picker (profile: ${profile})`, error)
  process.exitCode = 1
} finally {
  pendingResponse?.destroy()
  await app?.close()
  await new Promise((resolve) => server.close(resolve))
}
