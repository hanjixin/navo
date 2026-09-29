// First-run onboarding: welcome → connect a model → import MCP found on this machine → theme → start chatting.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2]
const home = mkdtempSync(join(tmpdir(), 'ab-home-'))
mkdirSync(join(home, '.agents/skills/demo'), { recursive: true })
writeFileSync(join(home, '.agents/skills/demo/SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\n')
writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { calc: { command: process.execPath, args: ['-e', ''] } } }))
const mock = startMock(38987)
const launch = (userData) => electron.launch({ args: ['.'], env: { ...process.env, HOME: home, AB_USER_DATA: userData } })
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const shot = async (app, name) => {
  if (!out) return
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(out, name), Buffer.from(png, 'base64'))
}

const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
let app = await launch(userData)
try {
  let page = await mainWindow(app, { onboarding: true })
  ok(await page.isVisible('text=欢迎使用 Navo'), 'fresh profile opens the welcome screen')
  ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length)) === 0, 'browser view hidden during onboarding')
  await shot(app, 'onboarding-welcome.png')
  await page.click('button:has-text("开始设置")')

  // model step: primary disabled until a model is verified
  ok(await page.isDisabled('footer button:has-text("下一步")'), 'next is disabled until a model works')
  await page.click('button:has-text("其他兼容接口")')
  await page.fill('input[placeholder="https://…/v1"]', mock.url)
  await page.fill('input[type=password]', 'sk-test')
  await page.click('button:has-text("连接")')
  await page.waitForSelector('text=连接成功', { timeout: 15000 })
  ok(true, 'custom endpoint connects, lists models and passes the live test')
  await shot(app, 'onboarding-model.png')
  const settingsModels = await page.evaluate(() => window.api.invoke('models.list'))
  ok(settingsModels.length === 1 && settingsModels[0].isDefault, 'model saved as default')
  await page.click('footer button:has-text("下一步")')

  // import step
  await page.waitForSelector('text=已自动接入')
  ok(await page.isVisible('text=calc'), 'MCP servers from other tools are offered')
  await page.click('label:has-text("calc")')
  await shot(app, 'onboarding-import.png')
  await page.click('footer button:has-text("导入 1 项并继续")')

  // theme step
  await page.click('button:has-text("深色")')
  ok((await page.evaluate(() => document.documentElement.classList.contains('dark'))) === true, 'theme applies instantly')
  await shot(app, 'onboarding-theme.png')
  await page.click('footer button:has-text("下一步")')

  // done
  ok(await page.isVisible('text=已导入 1 个 MCP 服务器'), 'summary reflects what was set up')
  await shot(app, 'onboarding-done.png')
  await page.click('button:has-text("打开 Hacker News")')
  await page.waitForSelector('nav')
  ok(await page.isVisible('text=打开 Hacker News，总结今天排名前 5 的文章'), 'starter task opens chat and sends the prompt')
  ok(
    (await page.evaluate(() => window.api.invoke('mcp.list'))).some((s) => s.name === 'calc'),
    'selected MCP server imported',
  )
  await app.close()

  // second launch goes straight to the app
  app = await launch(userData)
  page = await mainWindow(app, { onboarding: true })
  ok(!!(await page.$('nav')) && !(await page.$('[aria-label="首次设置"]')), 'onboarding shown only once')
  await app.close()

  // an existing profile that already has a model skips onboarding
  const legacy = mkdtempSync(join(tmpdir(), 'ab-profile-'))
  app = await launch(legacy)
  page = await mainWindow(app, { onboarding: true })
  await page.evaluate((u) => window.api.invoke('providers.save', { type: 'openai-compatible', name: 'x', baseURL: u, apiKey: 'x' }), mock.url)
  await page.evaluate(() => window.api.invoke('settings.set', { onboarded: false }))
  await app.close()
  app = await launch(legacy)
  page = await mainWindow(app, { onboarding: true })
  ok(!!(await page.$('nav')), 'users who already configured a provider are not forced through onboarding')

  // skip link
  await page.evaluate(() => window.api.invoke('settings.set', { onboarded: false }))
  await page.reload()
  await page.waitForSelector('text=跳过引导')
  await page.click('text=跳过引导')
  await page.waitForSelector('nav')
  ok(true, '"跳过引导" leaves onboarding')
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
  mock.server.close()
}
