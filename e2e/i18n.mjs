// English interface: switching the language reloads the windows; every page's navigation, headings,
// buttons, labels and text are English, main-process messages too; switching back restores Chinese.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const mock = startMock(38986)
// the language comes from the setting here, not from the suites' NAVO_LANG
const app = await electron.launch({ args: ['.'], env: { ...process.env, NAVO_LANG: '', AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
let win = await mainWindow(app)
const api = (m, ...a) => win.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15000) => {
  for (let i = 0; i < ms / 200; i++) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(200)
  }
  return null
}
/** visible interface text that still contains Chinese */
const chineseOnPage = () =>
  win.evaluate(() => {
    const HAN = /[㐀-鿿]/
    const seen = new Set()
    for (const el of document.querySelectorAll(
      '#root nav, #root h1, #root h2, #root h3, #root button, #root label, #root [role=tab], #root th, #root p, #root [placeholder]',
    )) {
      const text = `${el.textContent ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`
      // skills, memories and plugin descriptions are content, shown as written
      if (HAN.test(text) && el.getClientRects().length && !el.closest('[data-user-content]')) seen.add(text.trim().replace(/\s+/g, ' ').slice(0, 80))
    }
    return [...seen]
  })

const PAGES = ['chat', 'tasks', 'files', 'skills', 'connectors', 'mcp', 'memory', 'plugins', 'macros', 'models', 'usage', 'settings']

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- switch to English (the windows reload)
  await api('settings.set', { language: 'en' })
  await until(async () => (await win.evaluate(() => document.documentElement.lang)) === 'en')
  win = await mainWindow(app)
  await win.waitForSelector('nav', { timeout: 10000 })
  ok((await win.evaluate(() => document.documentElement.lang)) === 'en', 'switching the language reloads the window in English')
  const nav = await win.textContent('nav')
  ok(
    ['Chat', 'Tasks', 'Files', 'Skill', 'Connectors', 'Memory', 'Macros', 'Models', 'Usage', 'Settings'].every((n) => nav.includes(n)),
    'the navigation is English',
  )

  for (const page of PAGES) {
    await win.evaluate((p) => (window.location.hash = `#/${p}`), page)
    await sleep(700)
    const left = await chineseOnPage()
    ok(left.length === 0, `${page}: no Chinese left${left.length ? ` — ${left.slice(0, 4).join(' | ')}` : ''}`)
    if (['tasks', 'connectors', 'settings'].includes(page)) await win.screenshot({ path: join(out, `en-${page}.png`) })
  }

  // dialogs too
  await win.evaluate(() => (window.location.hash = '#/tasks'))
  await win.getByRole('button', { name: 'New task' }).first().click()
  await win.getByRole('tab', { name: 'Web monitor' }).click()
  await sleep(300)
  const dialogLeft = await win.evaluate(() => {
    const d = document.querySelector('[role=dialog]')
    return d && /[㐀-鿿]/.test(d.textContent) ? d.textContent.slice(0, 200) : ''
  })
  ok(!dialogLeft, `the task dialog is English${dialogLeft ? ` — ${dialogLeft}` : ''}`)
  await win.screenshot({ path: join(out, 'en-task-dialog.png') })
  await win.keyboard.press('Escape')

  // ---------- messages from the main process
  const err = await api('tasks.save', { name: '', prompt: 'x', kind: 'agent', cron: null, enabled: true }).then(
    () => '',
    (e) => String(e.message),
  )
  ok(/Name is required/.test(err), `errors from the main process are English (${err})`)
  const catalog = await api('connectors.catalog')
  ok(
    catalog.find((c) => c.id === 'email')?.fields.find((f) => f.key === 'password')?.label === 'Authorization code',
    'connector definitions are served in English',
  )

  // ---------- and back
  await api('settings.set', { language: 'zh' })
  await until(async () => (await win.evaluate(() => document.documentElement.lang).catch(() => '')) === 'zh-CN')
  win = await mainWindow(app)
  await win.waitForSelector('nav', { timeout: 10000 })
  ok((await win.textContent('nav')).includes('对话'), 'switching back restores Chinese')
} catch (e) {
  await win.screenshot({ path: join(out, 'i18n-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
