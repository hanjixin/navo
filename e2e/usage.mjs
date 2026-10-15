// Usage and cost: every model call is recorded with what it was for; prices set on a model turn
// tokens into estimated cost; a daily budget can pause Navo's background calls (not conversations).
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
let price = 1599
const site = createServer((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><main><h1>耳机</h1><p>¥${price}</p></main>`),
).listen(38998)

const mock = startMock(38999)
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
await win.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- a conversation's calls
  const t = await api('threads.create', m.id)
  await api('chat.send', t.id, '[plain] 你好')
  await until(async () => (await win.evaluate(() => window.__events)).some((e) => e.type === 'run_end'))
  let r = await until(async () => {
    const x = await api('usage.report', 7)
    return x.total.calls > 0 && x
  })
  const chat = r?.byPurpose.find((x) => x.purpose === 'chat')
  ok(
    chat?.calls >= 1 && chat.input > 0 && chat.output === 12 * chat.calls,
    `the conversation's model calls are recorded (${chat?.calls} calls, ${chat?.input} in / ${chat?.output} out)`,
  )
  ok(r.topThreads[0]?.threadId === t.id && r.byModel[0]?.name === 'Mock', 'by conversation and by model')
  ok(Object.keys(r.total.cost).length === 0 && r.total.unpriced === chat.input + chat.output, 'without a price: tokens only, counted as unpriced')

  // ---------- a price, set on the models page
  await win.evaluate(() => (window.location.hash = '#/models'))
  await win.getByRole('button', { name: '更多' }).last().click()
  await win.getByRole('menuitem', { name: '设置价格' }).click()
  await win.getByLabel('输入单价').fill('2')
  await win.getByLabel('输出单价').fill('3')
  await win.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  await win.waitForSelector('text=¥2 / ¥3', { timeout: 5000 })
  ok(true, 'the price shows on the model')
  r = await api('usage.report', 7)
  const expected = (chat.input * 2 + chat.output * 3) / 1e6
  ok(Math.abs((r.total.cost.CNY ?? 0) - expected) < 1e-9 && r.total.unpriced === 0, `cost estimated from the price (¥${r.total.cost.CNY?.toFixed(6)})`)

  // ---------- a background call (a monitor's judgment)
  const task = await api('tasks.save', {
    name: '耳机价格',
    kind: 'monitor',
    monitor: { url: 'http://127.0.0.1:38998/', condition: '低于 1500', action: 'notify' },
    prompt: '',
    modelId: null,
    cron: null,
    enabled: true,
  })
  await api('monitor.check', task.id)
  price = 1499
  let c = await api('monitor.check', task.id)
  r = await api('usage.report', 7)
  ok(!c.error && r.byPurpose.find((x) => x.purpose === 'monitor')?.calls === 1, 'a monitor judgment is recorded as a background call')

  // ---------- a daily budget that is used up pauses background calls, not conversations
  const s = await api('settings.get')
  await api('settings.set', { usage: { ...s.usage, dailyBudget: 0.000001, pauseBackground: true } })
  r = await api('usage.report', 7)
  ok(r.budget.paused && r.budget.spentToday > 0, 'over budget: background calls are paused')
  price = 1399
  c = await api('monitor.check', task.id)
  ok(/预算/.test(c.error ?? ''), `a monitor judgment waits (${c.error})`)
  await win.evaluate(() => window.__events.splice(0))
  await api('chat.send', t.id, '[plain] 再说一句')
  const end = await until(async () => (await win.evaluate(() => window.__events)).find((e) => e.type === 'run_end'))
  ok(end && !end.error, 'conversations are not affected by the budget')

  // ---------- the usage page
  await win.evaluate(() => (window.location.hash = '#/usage'))
  await win.waitForSelector('[data-testid=usage-chart]', { timeout: 5000 })
  const purposes = await win.textContent('[data-testid=usage-purpose]')
  ok(purposes.includes('对话') && purposes.includes('网页监控'), 'the page breaks usage down by purpose')
  ok(
    (await win.textContent('[data-testid=usage-threads]')).includes('你好') || (await win.$$('[data-testid=usage-threads] button')).length > 0,
    'and lists the conversations that used the most',
  )
  ok((await win.textContent('[data-testid=usage-budget]')).includes('今日已用'), 'the budget shows how much of it is used')
  ok((await win.textContent('main')).includes('暂停到明天'), 'and says background calls are paused')
  await sleep(300)
  await win.screenshot({ path: join(out, 'usage.png'), fullPage: true })
} catch (e) {
  await win.screenshot({ path: join(out, 'usage-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  site.close()
}
