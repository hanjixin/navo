// Web page monitors: set one up in the task dialog, then check a local shop page as it changes.
// Unchanged pages (or changes outside the watched part) cost no model call; a change is judged once
// against the condition; a trigger starts the agent; failing checks are counted.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const PORT = 38996
const BASE = `http://127.0.0.1:${PORT}`
const page = { price: 1599, promo: '满 1000 减 50', visits: 0 }
const site = createServer((req, res) => {
  const html = (s) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(s)
  if (req.url === '/product')
    return html(
      `<!doctype html><meta charset="utf-8"><title>AirPods Pro 2</title><body><main><h1>AirPods Pro 2</h1><p class="price">¥${page.price}</p><p>促销：${page.promo}</p><p>库存：有货</p></main><aside>浏览 ${++page.visits} 次</aside></body>`,
    )
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>Not Found</h1>')
}).listen(PORT)

const mock = startMock(38997)
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')), AB_MEMORY_IDLE_MS: '600000' },
})
const win = await mainWindow(app)
const api = (m, ...a) => win.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 20000) => {
  for (let i = 0; i < ms / 200; i++) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(200)
  }
  return null
}
/** the monitor's judgments (other model calls are the agent's) */
const judgments = () => mock.requests.filter((r) => JSON.stringify(r.messages?.[0] ?? '').includes('网页监控员')).length

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- 1. set it up in the task dialog
  await win.evaluate(() => (window.location.hash = '#/tasks'))
  await win.getByRole('button', { name: '新建任务' }).first().click()
  await win.getByRole('tab', { name: '网页监控' }).click()
  await win.getByPlaceholder('每日资讯摘要').fill('AirPods 降价提醒')
  await win.getByPlaceholder('https://…').fill(`${BASE}/product`)
  await win.getByPlaceholder('商品价格、公告列表…').fill('商品价格')
  await win.getByPlaceholder('价格低于 1500 元；或：出现新的公告').fill('价格低于 1500')
  await win.getByRole('button', { name: '试读一下' }).click()
  const preview = await win.waitForSelector('[data-testid=monitor-preview]', { timeout: 15000 })
  const previewText = await preview.textContent()
  ok(previewText.includes('¥1599') && !previewText.includes('浏览'), 'the preview shows what will be watched (the main content)')
  ok((await win.textContent('[role=dialog]')).includes('每 30 分钟'), 'a new monitor checks every 30 minutes by default')
  await win.screenshot({ path: join(out, 'monitor-dialog.png') })
  await win.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  const task = await until(async () => (await api('tasks.list')).find((t) => t.kind === 'monitor'))
  ok(task?.monitor?.condition === '价格低于 1500' && task.cron === '*/30 * * * *', 'saved as a monitor task')
  await api('tasks.save', { ...task, monitor: { ...task.monitor, action: 'agent', prompt: '把降价信息整理成一句话' } })

  // ---------- 2. checks
  let c = await api('monitor.check', task.id)
  ok(c.first && !c.error && judgments() === 0, 'first check: the content is recorded, no model call')
  c = await api('monitor.check', task.id)
  ok(!c.first && !c.changed && judgments() === 0, 'unchanged (the visit counter outside the main content changed): no model call')
  page.promo = '满 1000 减 80'
  c = await api('monitor.check', task.id)
  ok(c.changed && !c.triggered && judgments() === 1, `a change that doesn't meet the condition: judged once, no alert (${c.summary})`)
  ok(c.added.includes('促销：满 1000 减 80') && c.removed.includes('促销：满 1000 减 50'), 'the change is kept as added / removed lines')
  page.price = 1499
  const runsBefore = (await api('tasks.runs', task.id)).length
  c = await api('monitor.check', task.id)
  ok(c.triggered && judgments() === 2 && /1499/.test(c.summary ?? ''), `the price dropped below 1500: triggered (${c.summary})`)
  const run = await until(async () => (await api('tasks.runs', task.id)).find((r) => r.status === 'success'), 30000)
  ok(
    !!c.threadId && run?.threadId === c.threadId && (await api('tasks.runs', task.id)).length === runsBefore + 1,
    "the trigger ran the agent as one of the task's runs",
  )
  c = await api('monitor.check', task.id)
  ok(!c.changed && judgments() === 2, 'after the trigger, the new price is the baseline: no repeated alert')
  const again = await api('monitor.check', task.id)
  ok(again.id === c.id && again.repeats === 2, 'unchanged checks in a row are kept as one entry')

  // ---------- 3. failing checks
  const gone = await api('tasks.save', {
    name: '下架的页面',
    kind: 'monitor',
    monitor: { url: `${BASE}/gone`, action: 'notify' },
    prompt: '',
    modelId: null,
    cron: null,
    enabled: true,
  })
  for (let i = 0; i < 3; i++) c = await api('monitor.check', gone.id)
  ok(/404/.test(c.error ?? ''), `a missing page is a failed check (${c.error})`)
  const wrongPart = await api('tasks.save', {
    name: '区域写错了',
    kind: 'monitor',
    monitor: { url: `${BASE}/product`, selector: '.nope', action: 'notify' },
    prompt: '',
    modelId: null,
    cron: null,
    enabled: true,
  })
  c = await api('monitor.check', wrongPart.id)
  ok(/没有找到要看的区域/.test(c.error ?? ''), 'a selector that matches nothing says so')
  const summary = await api('monitor.summary')
  ok(summary[gone.id]?.failStreak === 3 && summary[task.id]?.triggers === 1 && summary[task.id]?.checks === 6, 'summaries: failures in a row, triggers, checks')

  // ---------- 4. the tasks page
  await win.evaluate(() => (window.location.hash = '#/chat'))
  await win.evaluate(() => (window.location.hash = '#/tasks'))
  await win.waitForSelector('[data-testid=monitor-summary]', { timeout: 5000 })
  ok((await win.textContent('main')).includes('连续失败 3 次'), 'the failing monitor is flagged on its card')
  ok(
    (await win.$$eval('[data-testid=monitor-summary]', (els) => els.map((e) => e.textContent))).some((t) => t.includes('已检查 6 次 · 触发 1 次')),
    'the card shows checks and triggers',
  )
  const card = win
    .locator('div', { hasText: 'AirPods 降价提醒' })
    .filter({ has: win.getByRole('button', { name: '记录' }) })
    .last()
  await card.getByRole('button', { name: '记录' }).click()
  await win.waitForSelector('[data-testid=monitor-check]', { timeout: 5000 })
  ok((await win.$$('[data-testid=monitor-check]')).length === 5, 'the history lists every check')
  const diff = await win.textContent('[data-testid=monitor-diff]')
  ok(diff.includes('+ ¥1499') && diff.includes('− ¥1599'), 'the triggering change is shown as a diff')
  await sleep(300)
  await win.screenshot({ path: join(out, 'monitor-history.png') })
} catch (e) {
  await win.screenshot({ path: join(out, 'monitor-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  site.close()
}
