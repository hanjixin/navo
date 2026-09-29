// Renders a mock conversation and saves screenshots of the chat UI (light + dark).
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const mock = startMock(38997)
const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const shot = async (name) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(out, name), Buffer.from(png, 'base64'))
}
const p = await api('providers.save', { type: 'openai-compatible', name: 'Local Mock', baseURL: mock.url, apiKey: 'x' })
await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock Model', supportsTools: true, supportsVision: false })
await page.reload()
await page.waitForSelector('nav')
await page.fill('textarea', '打开页面，告诉我主标题并保存到文件')
await page.keyboard.press('Enter')
await page.waitForTimeout(4000)
await page.click('text=/1\\/|Mock|已写入/', { timeout: 2000 }).catch(() => {})
await page
  .locator('button:has-text("打开网页")')
  .first()
  .click()
  .catch(() => {})
await page.waitForTimeout(300)
await shot('chat-light.png')
await api('settings.set', { theme: 'dark' })
await page.evaluate(() => location.reload())
await page.waitForSelector('nav')
await page.waitForTimeout(800)
await page.locator('text=打开页面，告诉我主标题并保存到文件').first().click()
await page.waitForTimeout(1200)
await shot('chat-dark.png')
await page.evaluate(() => (location.hash = '#/models'))
await page.waitForTimeout(800)
await shot('models-dark.png')
await app.close()
mock.server.close()
