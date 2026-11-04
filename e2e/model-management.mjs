// Imported provider models remain opt-in; only enabled models can be selected for chat.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-model-management-'))
const ids = Array.from({ length: 27 }, (_, index) => `import-model-${String(index + 1).padStart(2, '0')}`)
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }))
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
  const route = (path) =>
    win.evaluate((path) => {
      window.location.hash = path
    }, path)
  await route('/models')
  await win.getByRole('button', { name: '添加提供方', exact: true }).first().click()
  const providerDialog = win.getByRole('dialog')
  await providerDialog.getByRole('combobox').click()
  await win.getByRole('option', { name: 'OpenAI 兼容接口', exact: true }).click()
  await providerDialog.getByPlaceholder('OpenAI 兼容接口', { exact: true }).fill('Import fixture')
  await providerDialog.getByPlaceholder('http://localhost:11434/v1', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
  await providerDialog.locator('input[type=password]').fill('fixture-only')
  await providerDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(providerDialog).toBeHidden()
  const provider = (await api('providers.list')).find((item) => item.name === 'Import fixture')
  assert.ok(provider)
  const card = win.locator(`[data-testid="provider-card"][data-provider-id="${provider.id}"]`)
  await expect(card.getByTestId('model-row')).toHaveCount(27)
  const evidence = join(process.cwd(), '.superpowers/sdd/2026-11-04-workspace-improvements')
  mkdirSync(evidence, { recursive: true })
  await expect(card.getByTestId('model-row').first()).toBeVisible()
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await win.screenshot({ path: join(evidence, 'model-management.png') })

  let models = (await api('models.list')).filter((model) => model.providerId === provider.id)
  assert.equal(models.length, 27)
  assert.ok(models.every((model) => !model.enabled && !model.isDefault))
  const row = (id) => card.locator(`[data-testid="model-row"][data-model-id="${id}"]`)
  await row(ids[5])
    .getByRole('switch', { name: `启用模型 ${ids[5]}`, exact: true })
    .click()
  await expect(row(ids[5]).getByRole('switch')).toBeChecked()
  await row(ids[5]).getByRole('button', { name: '更多', exact: true }).click()
  await win.getByRole('menuitem', { name: '编辑', exact: true }).click()
  const dialog = win.getByRole('dialog')
  await dialog.getByPlaceholder(ids[5], { exact: true }).fill('My enabled model')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await card.getByRole('button', { name: '拉取 Import fixture 的模型', exact: true }).click()
  await expect(card.getByRole('button', { name: '拉取 Import fixture 的模型', exact: true })).toBeEnabled()
  models = (await api('models.list')).filter((model) => model.providerId === provider.id)
  assert.equal(models.length, 27, 'repeat imports do not duplicate models')
  const edited = models.find((model) => model.model === ids[5])
  assert.equal(edited.displayName, 'My enabled model')
  assert.equal(edited.enabled, true)
  await row(ids[10]).getByRole('switch').click()
  await expect(row(ids[10]).getByRole('switch')).toBeChecked()
  const thread = await api('threads.create', edited.id)
  await route(`/chat/${thread.id}`)
  await win.locator('main').getByRole('combobox').click()
  await expect(win.getByRole('option')).toHaveCount(2)
  await expect(win.getByRole('option', { name: 'My enabled model', exact: true })).toBeVisible()
  await expect(win.getByRole('option', { name: ids[10], exact: true })).toBeVisible()
  await win.keyboard.press('Escape')
  await route('/models')
  await row(ids[10]).getByRole('switch').click()
  await row(ids[5]).getByRole('switch').click()
  await expect(row(ids[5]).getByRole('switch')).not.toBeChecked()
  await route(`/chat/${thread.id}`)
  await expect(win.locator('main')).toContainText('没有已启用的模型，请前往模型页面启用')
  await expect(win.locator('main').getByRole('link', { name: '管理模型', exact: true })).toBeVisible()
  await expect(win.locator('main').getByRole('combobox')).toHaveCount(0)
  // Manual addition of an imported ID reuses its row instead of creating a duplicate.
  await route('/models')
  await card.getByRole('button', { name: '添加模型', exact: true }).first().click()
  await dialog.getByRole('combobox', { name: '模型 ID', exact: true }).fill(ids[5])
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  const finalModels = (await api('models.list')).filter((model) => model.providerId === provider.id)
  assert.equal(finalModels.length, 27)
  assert.equal(finalModels.find((model) => model.model === ids[5]).id, edited.id)
  assert.equal(finalModels.find((model) => model.model === ids[5]).enabled, true)
  console.log('PASS model management: 27 disabled imports, UI enable/edit, idempotent refresh, active-only chat options and all-disabled guidance')
} catch (error) {
  console.error(`FAIL model-management (profile: ${profile})`, error)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve) => server.close(resolve))
}
