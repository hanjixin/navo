// The user's own browser: a Chromium with the Navo extension pairs with Navo, and browser_* tools
// work in it after browser_switch('mine'). No LLM involved. Needs `pnpm build:extension` and
// Playwright's Chromium (`pnpm exec playwright install chromium`).
import { _electron as electron, chromium } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
<button id=go onclick="window.submitCount=(window.submitCount||0)+1;document.getElementById('out').textContent='Hello '+document.getElementById('n').value">Submit</button>
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
  if (!live) console.log('VIEW DEBUG', await api('computerUse.viewState'), await page.textContent('[data-testid="external-toolbar"]'))
  ok(((await live?.getAttribute('src')) ?? '').startsWith('data:image/jpeg'), "Navo's browser panel shows the user's tab live")
  ok((await page.textContent('[data-testid="external-toolbar"]'))?.includes('Form Test'), 'with the title of that tab')

  ok((await page.locator('[aria-label="输入网址或搜索"]').count()) === 0, 'external toolbar has no editable built-in address')
  ok((await page.locator('[aria-label="刷新"]').count()) === 0, 'external toolbar cannot reload the built-in browser')
  const builtinBeforeViewSwitch = await api('browser.state')
  await page.getByRole('button', { name: '查看内置浏览器', exact: true }).click()
  await page.getByRole('button', { name: '查看外部浏览器', exact: true }).click()
  ok(JSON.stringify((await api('browser.state')).tabs) === JSON.stringify(builtinBeforeViewSwitch.tabs), 'view selection does not mutate built-in tabs')
  await page.getByRole('button', { name: '重试画面', exact: true }).click()

  // a tab the user opened is out of reach
  const userTab = await browser.newPage()
  await userTab.goto(`${site}/other`)
  const list = JSON.parse(await tool('browser_tabs', { action: 'list' }))
  ok(list.length === 1 && list[0].current && !list.some((t) => t.title === 'User Tab'), "the user's own tabs are not listed")

  // Exercise the actual extension popup -> background handler, without touching the
  // developer's browser, extension profile, or production bridge ports.
  const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
  const workerUrl = new URL(worker.url())
  const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`
  const popup = await browser.newPage()
  await popup.goto(`${extensionOrigin}/popup.html`)
  const popupMessage = (message) => popup.evaluate((value) => globalThis.chrome.runtime.sendMessage(value), message)
  const userTabId = await popup.evaluate(async (url) => (await globalThis.chrome.tabs.query({})).find((tab) => tab.url === url)?.id, userTab.url())
  const controlledTabId = list[0].id
  const controlledPage = browser.pages().find((candidate) => candidate.url() === site + '/')
  if (!controlledPage || userTabId == null) throw new Error('Expected isolated controlled and user-owned test tabs')
  ok((await popupMessage({ t: 'handover', tabId: userTabId })).ok, 'popup hands a second tab to Navo')
  ok((await popupMessage({ t: 'revoke', tabId: controlledTabId })).ok, 'popup revokes the tab currently controlled by Navo')
  const revokedSnapshot = await tool('browser_snapshot', {})
  const revokedClick = await tool('browser_click', { ref: ref('button "Submit"') })
  ok(/已收回|控制已结束|重新选择|没有交给/.test(revokedSnapshot), 'snapshot cannot reuse a revoked tab driver')
  ok(/已收回|控制已结束|重新选择|没有交给/.test(revokedClick), 'click cannot reuse a revoked tab driver')
  ok((await controlledPage.evaluate(() => window.submitCount)) === 1, 'rejected click did not modify the real page')
  const availableAfterRevoke = JSON.parse(await tool('browser_tabs', { action: 'list' }))
  ok(
    availableAfterRevoke.some((tab) => tab.id === userTabId) && !availableAfterRevoke.some((tab) => tab.id === controlledTabId),
    'list remains available after revocation and lists only other authorized tabs',
  )
  ok((await popupMessage({ t: 'handover', tabId: controlledTabId })).ok, 'user can explicitly hand the tab back')
  const selectedAgain = await tool('browser_tabs', { action: 'switch', tabId: controlledTabId })
  ok(selectedAgain.includes('Hello Ada'), 'explicit switch reacquires the newly authorized tab')

  // Keep Chromium alive while the real WebSocket server is stopped and restarted.
  // No mutation is retried: the fixture counts all dispatched Submit clicks.
  const settingsBeforeDisconnect = await api('settings.get')
  await api('settings.set', { computerUse: { ...settingsBeforeDisconnect.computerUse, myBrowser: false } })
  ok(await waitFor(async () => !(await api('computerUse.status')).browser.connected), 'disabling my-browser disconnects the isolated bridge')
  ok(
    await waitFor(() =>
      popup.evaluate(async (tabId) => {
        // getTargets().attached also counts Playwright's connection. Ask Chrome
        // whether this extension still owns a debugger session, using a read-only command.
        try {
          await globalThis.chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
          return false
        } catch (error) {
          return /not attached/i.test(error.message)
        }
      }, controlledTabId),
    ),
    'the extension actually detaches Chrome debugger after disconnection',
  )
  ok(!controlledPage.isClosed(), 'the controlled Chromium tab remains open during bridge outage')
  ok((await api('computerUse.viewState')).status === 'disconnected', 'view reports disconnection without requiring an agent action')
  ok((await page.textContent('[data-testid="external-view"]'))?.includes('画面已暂停'), 'last frame is visibly paused')
  const evidence = join(process.cwd(), '.superpowers/sdd/2026-11-05-reliability')
  mkdirSync(evidence, { recursive: true })
  await page.screenshot({ path: join(evidence, 'external-browser-disconnected.png') })

  await api('settings.set', { computerUse: { ...settingsBeforeDisconnect.computerUse, myBrowser: true } })
  ok(await waitFor(async () => (await api('computerUse.status')).browser.paired), 'the same extension reconnects without another pairing prompt')
  const reconnectedSnapshot = await tool('browser_snapshot', {})
  ok(reconnectedSnapshot.includes('Hello Ada'), 'the remembered tab reattaches successfully after reconnect')
  ok((await controlledPage.evaluate(() => window.submitCount)) === 1, 'reconnection does not replay the previous mutation')
  const reconnectedSubmit = /\[(e\d+)\] button "Submit"/.exec(reconnectedSnapshot)?.[1]
  if (!reconnectedSubmit) throw new Error('Submit button missing after reconnect')
  await tool('browser_click', { ref: reconnectedSubmit })
  ok((await controlledPage.evaluate(() => window.submitCount)) === 2, 'a new click after reconnect executes exactly once')
  await popup.close()

  const back = await tool('browser_switch', { target: 'builtin' })
  ok(back.includes('内置浏览器'), 'switched back to the built-in browser')
  ok((await api('computerUse.viewState')).status === 'released', 'view marks the old target released')
  await page.getByRole('button', { name: '查看内置浏览器', exact: true }).click()
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
