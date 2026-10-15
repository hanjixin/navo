// Quick ask: global shortcuts registered, the quick window answers, offers fresh clipboard content,
// hands the conversation to the main window; closing the main window keeps Navo running.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const mock = startMock(38991)
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(100)
  }
  return null
}
const quickPage = () => until(async () => app.windows().find((w) => w.url().includes('#/quick')))
const quickVisible = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('#/quick') && w.isVisible()))

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- shortcuts
  const reg = await app.evaluate(({ globalShortcut }) => [globalShortcut.isRegistered('Alt+Space'), globalShortcut.isRegistered('Alt+Shift+Space')])
  ok(reg[0] && reg[1], 'global shortcuts are registered')
  const s = await api('settings.get')
  await api('settings.set', { quick: { ...s.quick, shortcut: 'Alt+Shift+K' } })
  ok(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+Shift+K') && !globalShortcut.isRegistered('Alt+Space')),
    'changing the shortcut re-registers it',
  )
  await api('settings.set', { quick: { ...s.quick, shortcut: 'NotAKey+Q' } })
  ok((await api('quick.status')).failed.includes('NotAKey+Q'), 'a shortcut that cannot be registered is reported')
  await api('settings.set', { quick: s.quick })

  // ---------- ask from the quick window
  await api('quick.show')
  const q = await quickPage()
  await until(() => quickVisible())
  ok(!!q && (await quickVisible()), 'the quick window opens')
  await q.waitForSelector('textarea')
  await q.fill('textarea', '[plain] 快问一下')
  await q.keyboard.press('Enter')
  ok(!!(await until(() => q.$('text=好的。'))), 'it answers in the quick window')
  await q.screenshot({ path: join(out, 'quick-window.png') })
  const tid = await q.evaluate(() => window.__navoActiveThread?.() ?? null)

  // ---------- clipboard: offered once while fresh, sent as an attachment
  // unique per run: the system clipboard outlives the test, and unchanged content is (rightly) not "fresh"
  const copied = `合同编号 HT-2026-0931，付款日期十月十五日（${Date.now()}）`
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), copied)
  await q.keyboard.press('Meta+N')
  await api('quick.show')
  const chip = await q.waitForSelector('text=问刚复制的内容', { timeout: 5000 }).catch(() => null)
  ok(!!chip, 'freshly copied text is offered')
  await chip?.click()
  ok(!!(await q.waitForSelector('text=剪贴板.txt', { timeout: 5000 }).catch(() => null)), 'accepting it attaches the text')
  await q.fill('textarea', '[plain] 这段内容讲了什么')
  await q.keyboard.press('Enter')
  const sent = await until(async () => mock.requests.find((r) => JSON.stringify(r.messages).includes('这段内容讲了什么')))
  ok(JSON.stringify(sent?.messages ?? '').includes('HT-2026-0931'), 'the copied text reaches the model')
  await api('quick.show')
  await sleep(300)
  ok(!(await q.$('text=问刚复制的内容')), 'the same clipboard content is not offered twice')

  // ---------- Esc puts it away; "continue in Navo" opens the conversation in the main window
  await q.keyboard.press('Escape')
  await until(async () => !(await quickVisible()))
  ok(!(await quickVisible()), 'Esc hides the quick window')
  await api('quick.show')
  await until(() => quickVisible())
  await q.getByRole('button', { name: '在 Navo 中继续' }).click()
  await until(async () => !(await quickVisible()))
  ok(!!(await until(() => page.$('text=这段内容讲了什么'))), 'continue in Navo: the main window shows the conversation')
  void tid

  // ---------- closing the main window keeps Navo running
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('index.html') && !w.webContents.getURL().includes('#/quick'))
      ?.close(),
  )
  await sleep(500)
  const state = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('#/quick') && x.webContents.getURL().includes('index.html'))
    return { exists: !!w && !w.isDestroyed(), visible: !!w?.isVisible() }
  })
  ok(state.exists && !state.visible, 'closing the main window hides it (Navo stays in the menu bar)')
  await api('quick.openInMain', null)
  await sleep(300)
  ok(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((x) => !x.webContents.getURL().includes('#/quick') && x.isVisible())),
    '"Open Navo" brings it back',
  )
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
