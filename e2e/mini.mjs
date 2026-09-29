// Collapsed browser panel: the agent's page shows in a floating mini window (live frames), double-click expands.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const mock = startMock(38984)
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000) => {
  for (let t = 0; t < ms / 100; t++) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(100)
  }
  return null
}
/** bounds of the page views attached to the main window, plus its content width */
const views = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html'))
    return { width: w.getContentBounds().width, views: w.contentView.children.map((c) => c.getBounds()) }
  })
const mini = () => page.$('[data-testid=browser-mini]')
const shot = async (name) => writeFileSync(join(out, name), await page.screenshot())

try {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.webContents.getURL().includes('index.html'))
      .setContentSize(1400, 860),
  )
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  const t = await api('threads.create', m.id)

  // collapse the panel, then let the agent browse
  await page.getByRole('button', { name: '切换浏览器面板' }).click()
  await sleep(300)
  ok(!(await mini()), 'collapsed panel, idle: no mini window')
  await api('chat.send', t.id, '[navhold:Mini]')
  ok(!!(await until(mini)), 'agent starts browsing: mini window appears (panel stays collapsed)')
  const frame = await until(() =>
    page.$eval('[data-testid=browser-mini] img[alt="浏览器实时画面"]', (i) => i.naturalWidth > 0 && i.src.startsWith('data:image/jpeg')),
  )
  ok(!!frame, 'mini window shows live frames of the page')
  const v1 = await views()
  ok(
    v1.views.length === 1 && v1.views[0].x >= v1.width && v1.views[0].width >= 360,
    `page keeps rendering off-screen at full size (${JSON.stringify(v1.views[0])})`,
  )

  // drag by the header
  const box = await (await mini()).boundingBox()
  ok(box.y > 40 && box.y < 140, `opens top-right, clear of the composer (y=${Math.round(box.y)})`)
  await page.mouse.move(box.x + 60, box.y + 14)
  await page.mouse.down()
  await page.mouse.move(box.x - 140, box.y + 114, { steps: 6 })
  await page.mouse.up()
  const moved = await (await mini()).boundingBox()
  ok(
    Math.abs(moved.x - (box.x - 200)) < 4 && Math.abs(moved.y - (box.y + 100)) < 4,
    `mini window can be dragged (${Math.round(box.x)},${Math.round(box.y)} → ${Math.round(moved.x)},${Math.round(moved.y)})`,
  )
  // resize from the bottom-left grip
  await page.mouse.move(moved.x + 6, moved.y + moved.height - 6)
  await page.mouse.down()
  await page.mouse.move(moved.x - 94, moved.y + moved.height + 40, { steps: 6 })
  await page.mouse.up()
  const bigger = await (await mini()).boundingBox()
  ok(
    Math.abs(bigger.width - (moved.width + 100)) < 4 && Math.abs(bigger.x + bigger.width - (moved.x + moved.width)) < 4,
    `resize grip enlarges it, right edge stays (${Math.round(moved.width)} → ${Math.round(bigger.width)})`,
  )
  ok(
    !!(await until(() => page.$eval('[data-testid=browser-mini]', (el) => el.textContent.includes('Page Mini')), 6000)),
    'mini window follows the tab the agent is using',
  )
  await until(() => page.$eval('[data-testid=browser-mini] img', (i) => i.src.length > 0))
  await sleep(800)
  await shot('mini-window.png')

  // double-click expands the panel
  await (await mini()).dblclick({ position: { x: 150, y: 100 } })
  ok(!!(await until(async () => !(await mini()))), 'double-click opens the browser panel and hides the mini window')
  const v2 = await until(async () => {
    const v = await views()
    return v.views.length === 1 && v.views[0].x < v.width && v.views[0].x > 0 ? v : null
  })
  ok(!!v2, 'the page view is back on screen inside the panel')

  // collapse while the agent is still working → mini again; closing it stops the preview
  await page.getByRole('button', { name: '切换浏览器面板' }).click()
  ok(!!(await until(mini, 3000)), 'collapsing during a run keeps the page visible in the mini window')
  await page.getByRole('button', { name: '关闭小窗' }).click()
  ok(!(await mini()), 'close button hides the mini window')
  const v3 = await until(async () => ((await views()).views.length === 0 ? true : null), 3000)
  ok(!!v3, 'no preview: the page view is detached again')
  // the header status re-opens it
  await page.getByRole('button', { name: '显示浏览器小窗' }).click()
  ok(!!(await until(mini, 3000)), 'status chip in the title bar shows the mini window again')
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
