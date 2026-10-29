// The user's own browser: a Chromium with the Navo extension pairs with Navo, and browser_* tools
// work in it after browser_switch('mine'). No LLM involved. Needs `pnpm build:extension` and
// Playwright's Chromium (`pnpm exec playwright install chromium`).
import { _electron as electron, chromium } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) process.exitCode = 1
}
const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

const FORM = `<!doctype html><title>Form Test</title>
<h1>Signup</h1><label for=n>Name</label><input id=n name=username>
<button id=go onclick="document.getElementById('out').textContent='Hello '+document.getElementById('n').value">Submit</button>
<p id=out></p>`
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(req.url === '/other' ? '<title>User Tab</title><p>mine' : FORM)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const site = `http://127.0.0.1:${server.address().port}`

const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
// a copy of the extension on its own port: a Navo extension in the developer's real browser (which
// probes 38810–38819) must never pair with this test app
const TEST_PORT = 38870
const ext = mkdtempSync(join(tmpdir(), 'ab-ext-'))
cpSync(resolve('dist/extension'), ext, { recursive: true })
const bg = join(ext, 'background.js')
writeFileSync(bg, readFileSync(bg, 'utf8').replace(/const PORTS = .*\n/, `const PORTS = [${TEST_PORT}]\n`))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData, NAVO_BRIDGE_PORT: String(TEST_PORT) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const tool = (name, args) => api('dev.invokeTool', name, args).catch((e) => `ERROR ${e.message ?? e}`)
let browser = null

try {
  const s = await api('settings.get')
  await api('settings.set', { computerUse: { ...s.computerUse, myBrowser: true } })
  const tools = await api('dev.tools')
  ok(
    tools.some((t) => t.name === 'browser_switch'),
    'browser_switch offered when "use my browser" is on',
  )

  const before = await tool('browser_switch', { target: 'mine' })
  ok(before.includes('还没有连接 Navo 浏览器扩展'), 'without the extension the agent is told to ask the user')
  const guide = await page.waitForSelector('[data-testid="extension-guide"]', { timeout: 10000 }).catch(() => null)
  ok(!!guide, 'the import guide opens for the user')
  const dir = (await api('computerUse.status')).browser.extensionDir
  ok(existsSync(join(dir, 'manifest.json')), `the extension is copied for "Load unpacked" (${dir})`)
  // a copy where Chrome's folder picker can reach it (the system dialog is answered in the main process)
  const exportTo = mkdtempSync(join(tmpdir(), 'ab-export-'))
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
  }, exportTo)
  await page.getByRole('button', { name: '导出到其他文件夹…' }).click()
  const exported = join(exportTo, 'Navo 扩展')
  await waitFor(async () => (await api('computerUse.status')).browser.extensionDir === exported, 5000)
  ok(existsSync(join(exported, 'manifest.json')), 'the extension can be exported to a folder the user picks')
  const shownDir = await waitFor(async () => {
    const text = (await page.textContent('[data-testid="extension-dir"]'))?.trim()
    return text === exported ? text : null
  }, 5000)
  ok(shownDir === exported, 'the guide then points at the exported folder')
  await page.keyboard.press('Escape')

  browser = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ab-chrome-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  const pairing = await waitFor(async () => (await api('computerUse.status')).browser.pairingCode)
  ok(/^\d{6}$/.test(pairing ?? ''), `the extension asks to pair (${pairing})`)
  // the main window asks the user to compare the code
  const shown = await page.waitForSelector('[data-testid="pairing-code"]', { timeout: 10000 }).catch(() => null)
  ok((await shown?.textContent())?.trim() === pairing, 'the pairing code is shown for the user to confirm')
  await page.getByRole('button', { name: '确认连接' }).click()
  const paired = await waitFor(async () => (await api('computerUse.status')).browser.paired)
  ok(paired, 'paired after the user confirms')
  ok((await api('computerUse.status')).browser.browser === 'Chromium', 'paired with the test browser')

  const switched = await tool('browser_switch', { target: 'mine' })
  ok(switched.startsWith('已切换到你的浏览器'), `switched to the user's browser (${switched.split('\n')[0]})`)

  const nav = await tool('browser_navigate', { url: site })
  ok(/\[e\d+\] textbox "Name"/.test(nav), 'navigate + snapshot in the user browser')
  const ref = (label) => new RegExp(`\\[(e\\d+)\\] ${label}`).exec(nav)?.[1]
  await tool('browser_type', { ref: ref('textbox "Name"'), text: 'Ada' })
  const after = await tool('browser_click', { ref: ref('button "Submit"') })
  ok(after.includes('Hello Ada'), 'type + click through the extension')
  const text = await tool('browser_extract', {})
  ok(text.includes('Hello Ada'), 'extract text')
  ok(
    browser.pages().some((p) => p.url().startsWith(site)),
    'the page opened in the real browser',
  )
  // the browser panel shows the agent's tab live
  const live = await page.waitForSelector('[data-testid="external-view"] img', { timeout: 10000 }).catch(() => null)
  ok(((await live?.getAttribute('src')) ?? '').startsWith('data:image/jpeg'), "Navo's browser panel shows the user's tab live")
  ok((await page.textContent('[data-testid="external-view"]'))?.includes('Form Test'), 'with the title of that tab')

  // a tab the user opened is out of reach
  const userTab = await browser.newPage()
  await userTab.goto(`${site}/other`)
  const list = JSON.parse(await tool('browser_tabs', { action: 'list' }))
  ok(list.length === 1 && list[0].current && !list.some((t) => t.title === 'User Tab'), "the user's own tabs are not listed")

  const back = await tool('browser_switch', { target: 'builtin' })
  ok(back.includes('内置浏览器'), 'switched back to the built-in browser')
  ok(
    await page
      .waitForSelector('[data-testid="external-view"]', { state: 'detached', timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    'the live picture goes away when the agent is back in the built-in browser',
  )
  const builtinNav = await tool('browser_navigate', { url: site })
  ok(/textbox "Name"/.test(builtinNav), 'built-in browser still works')

  await tool('browser_switch', { target: 'mine' })
  await browser.close()
  browser = null
  // quitting the browser closes its tabs first: the agent hears that, then that the browser is gone
  const gone = await tool('browser_snapshot', {})
  ok(gone.includes('标签页已被关闭'), `a closed browser's tab is reported: ${gone.slice(0, 80)}`)
  const started = Date.now()
  const offline = await tool('browser_tabs', { action: 'new' })
  ok(
    offline.includes('与浏览器扩展的连接已断开') && Date.now() - started >= 14000,
    `opening a tab waits for the browser, then says it is gone (${Math.round((Date.now() - started) / 1000)}s)`,
  )
} catch (err) {
  ok(false, `exception ${err.stack ?? err}`)
} finally {
  await browser?.close().catch(() => undefined)
  await app.close()
  server.close()
}
