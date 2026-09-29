// Layout interactions: resizable browser gutter, collapse-by-drag, sidebar toggle, responsive breakpoints.
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
const page = await mainWindow(app)
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const setSize = (w, h = 900) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])
const nativeBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0]?.getBounds() ?? null)
const navWidth = () => page.$eval('nav', (n) => n.getBoundingClientRect().width)
const shot = async (name) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(out, name), Buffer.from(png, 'base64'))
}

try {
  await setSize(1480)
  await page.waitForTimeout(500)
  ok((await navWidth()) === 208, 'wide window: sidebar expanded')

  // drag the gutter 200px to the left
  const g = await page.$('[role=separator]')
  const box = await g.boundingBox()
  const before = (await nativeBounds()).width
  await page.mouse.move(box.x + 3, box.y + 300)
  await page.mouse.down()
  for (let i = 0; i < 20 && (await nativeBounds()) !== null; i++) await page.waitForTimeout(50)
  ok((await nativeBounds()) === null, 'native view swapped for snapshot while dragging')
  await page.mouse.move(box.x - 200, box.y + 300, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const after = await nativeBounds()
  ok(after && Math.abs(after.width - (before + 200)) <= 6, `drag widens browser ${before} → ${after?.width}`)

  // dragging far right beyond min collapses the panel
  const box2 = await (await page.$('[role=separator]')).boundingBox()
  await page.mouse.move(box2.x + 3, box2.y + 300)
  await page.mouse.down()
  // no waiting: the native view is hidden on pointerdown, so moving straight over it keeps the drag
  await page.mouse.move(1470, box2.y + 300, { steps: 10 })
  // poll instead of fixed sleeps: under full-suite load the UI can take a few hundred ms longer
  const hint = await page.waitForSelector('text=松开以收起浏览器', { timeout: 2000 }).catch(() => null)
  ok(!!hint, 'collapse hint shown when dragged past minimum')
  await page.mouse.up()
  await page.waitForSelector('[role=separator]', { state: 'detached', timeout: 2000 }).catch(() => null)
  ok(!(await page.$('[role=separator]')) && (await nativeBounds()) === null, 'release collapses browser panel')

  // reopen via shortcut, double-click resets width
  await page.keyboard.press('ControlOrMeta+Backslash')
  await page.waitForSelector('[role=separator]', { timeout: 3000 })
  await page.dblclick('[role=separator]')
  await page.waitForTimeout(300)
  ok((await nativeBounds())?.width === 560, 'shortcut reopens + double-click resets to default width')

  // sidebar toggle
  await page.keyboard.press('ControlOrMeta+b')
  await page.waitForTimeout(350)
  ok((await navWidth()) === 56, 'Cmd/Ctrl+B collapses sidebar to icon rail')
  await shot('layout-collapsed.png')
  await page.keyboard.press('ControlOrMeta+b')
  await page.waitForTimeout(350)
  ok((await navWidth()) === 208, 'Cmd/Ctrl+B expands again')

  // responsive: clear explicit prefs, then narrow window
  await page.evaluate(() => {
    localStorage.removeItem('layout.sidebar')
    localStorage.removeItem('layout.threads')
  })
  await page.reload()
  await page.waitForSelector('nav')
  await setSize(1100)
  await page.waitForTimeout(600)
  ok((await navWidth()) === 56, 'narrow window auto-collapses sidebar')
  ok(!(await page.isVisible('input[placeholder="搜索对话"]')), 'narrow chat column hides thread list')
  const nb = await nativeBounds()
  const mainW = await page.$eval('main', (m) => m.getBoundingClientRect().width)
  ok(mainW >= 440, `content keeps minimum width (${Math.round(mainW)}px, browser ${nb?.width}px)`)
  await shot('layout-1100.png')
  await setSize(1480)
  await page.waitForTimeout(600)
  ok((await navWidth()) === 208 && (await page.isVisible('input[placeholder="搜索对话"]')), 'widening restores sidebar + thread list')
  await shot('layout-1480.png')

  // long titles truncate instead of stretching the conversation list
  const api0 = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
  const lt = await api0('threads.create', null)
  await api0('threads.rename', lt.id, 'https://www.example.com/a/very/long/url/without/any/spaces/that/cannot/wrap/anywhere/at/all/' + 'x'.repeat(80))
  await page.evaluate(() => (location.hash = '#/chat'))
  await page.waitForTimeout(600)
  const widths = await page.evaluate(() => {
    const list = document.querySelector('input[placeholder="搜索对话"]')?.closest('.border-r')
    if (!list) return null
    return { list: list.getBoundingClientRect().width, items: [...list.querySelectorAll('.group')].map((e) => e.getBoundingClientRect().width) }
  })
  ok(
    widths && widths.items.length && widths.items.every((w) => w <= widths.list),
    `long titles don't stretch the conversation list (${JSON.stringify(widths)})`,
  )

  // agent activity on a collapsed panel shows the mini window instead of re-opening it
  const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
  await page.keyboard.press('ControlOrMeta+Backslash')
  await page.waitForTimeout(300)
  ok(!(await page.$('[role=separator]')), 'panel collapsed before agent acts')
  await api('dev.invokeTool', 'browser_navigate', { url: 'data:text/html,<title>Agent Page</title>hi' })
  for (let i = 0; i < 30 && !(await page.$('[data-testid=browser-mini]')); i++) await page.waitForTimeout(100)
  ok(
    !(await page.$('[role=separator]')) && !!(await page.$('[data-testid=browser-mini]')),
    'agent using the browser shows the mini window, panel stays collapsed',
  )
  await page.dblclick('[data-testid=browser-mini]')
  await page.waitForTimeout(500)
  ok(!!(await page.$('[role=separator]')) && (await nativeBounds())?.x > 0, 'double-clicking the mini window re-opens the panel')

  // links in the app UI open as a tab in the panel instead of the system browser
  await page.keyboard.press('ControlOrMeta+Backslash')
  await page.waitForTimeout(300)
  const before2 = (await api('browser.state')).tabs.length
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.href = 'https://example.com/'
    a.target = '_blank'
    a.textContent = 'link'
    a.id = 'test-link'
    document.body.appendChild(a)
  })
  await page.click('#test-link')
  await page.waitForTimeout(700)
  const st2 = await api('browser.state')
  ok(
    st2.tabs.length === before2 + 1 && st2.tabs.find((t) => t.active)?.url.includes('example.com') && !!(await page.$('[role=separator]')),
    'chat links open in a new panel tab and reveal the panel',
  )
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
}
