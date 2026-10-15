// Fixed flows on a "legacy" ERP: the agent does it once with the model → kept as a flow → replays
// with 0 model calls → the page is redesigned, the replay breaks → the agent finishes and the flow is
// updated → replays without the model again.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const exported = []
let version = 1
// an old system: element ids change on every load (useless as selectors), the labels are what's stable
const rid = () => `f_${Math.floor(Math.random() * 1e6)}`
const page = (body) => `<!doctype html><meta charset="utf-8"><title>ERP</title><body style="font:15px system-ui;margin:24px">${body}</body>`
const site = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const html = (s) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(s))
  if (url.pathname === '/admin/v2') return ((version = 2), res.writeHead(200).end('v2'))
  if (url.pathname === '/orders')
    return html(
      version === 1
        ? `<h1>订单管理</h1><form action="/orders/result"><label for="${rid()}">订单号</label> <input id="${rid()}" name="no" aria-label="订单号"> <button>查询</button></form>`
        : // v2: renamed field and button, extra wrapper
          `<h1>订单中心 2.0</h1><div class="search"><form action="/orders/result"><input id="${rid()}" name="order_code" aria-label="单号查询" placeholder="输入单号"> <button>搜索</button></form></div>`,
    )
  if (url.pathname === '/orders/result') {
    const no = url.searchParams.get('no') ?? url.searchParams.get('order_code')
    return html(`<h1>订单 ${no}</h1><p>状态：已发货</p><form action="/orders/export"><input type="hidden" name="no" value="${no}"><button>导出</button></form>`)
  }
  if (url.pathname === '/orders/export') {
    exported.push(url.searchParams.get('no'))
    return html(`<h1>已导出 ${url.searchParams.get('no')}</h1>`)
  }
  res.writeHead(404).end()
}).listen(38992)

const mock = startMock(38993)
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
  window.__suggest = []
  window.__repaired = []
  window.api.on('chat.event', (e) => window.__events.push(e))
  window.api.on('flows.suggest', (e) => window.__suggest.push(e))
  window.api.on('flows.repaired', (e) => window.__repaired.push(e))
})
const runTask = async (taskId) => {
  const run = await api('tasks.run', taskId)
  return until(async () => (await api('tasks.runs', taskId)).find((r) => r.id === run.id && r.status !== 'running'), 60000)
}
/** model calls made by the agent (not counting background memory / skill passes) */
const agentCalls = () => mock.requests.length

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- 1. the agent works it out once, with the model
  const t = await api('threads.create', m.id)
  await win.evaluate(() => (window.location.hash = '#/chat'))
  await win.evaluate(() => window.__events.splice(0))
  await api('chat.send', t.id, '[legacy:A-1001] 以后每天帮我在 ERP 里导出这个订单')
  await until(async () => (await win.evaluate(() => window.__events)).some((e) => e.type === 'run_end'), 60000)
  ok(exported.includes('A-1001'), 'the agent exported the order (with the model)')
  ok(
    (await win.evaluate(() => window.__suggest)).some((s) => s.threadId === t.id),
    'the task sounds recurring: keeping it as a flow is offered',
  )
  const info = await api('flows.traceInfo', t.id)
  ok(info?.actions >= 3, `the run left a replayable trace (${info?.actions} actions)`)

  // ---------- 2. keep it as a flow (through the UI)
  // open it the way "continue in Navo" does (works with the conversation list hidden on small windows)
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:quick.openThread', id)
  }, t.id)
  const btn = await win.waitForSelector('button:has-text("固化流程")', { timeout: 8000 }).catch(() => null)
  ok(!!btn, 'the conversation offers "固化流程"')
  await btn?.click()
  await win.waitForSelector('[data-testid=flow-step]', { timeout: 15000 })
  const stepTexts = await win.$$eval('[data-testid=flow-step]', (els) => els.map((e) => e.textContent))
  ok((await win.$$('[data-testid=flow-param]')).length === 1 && stepTexts.some((s) => s.includes('{{order_no}}')), 'the order number became a parameter')
  await sleep(500)
  await win.screenshot({ path: join(out, 'flow-dialog.png') })
  await win.getByRole('button', { name: '保存流程' }).click()
  const flow = await until(async () => (await api('macros.list')).find((x) => x.name === '导出订单'))
  ok(!!flow && flow.exposeAsTool && flow.params[0]?.name === 'order_no', 'saved as a flow the agent can also call as a tool')
  ok(!JSON.stringify(flow?.steps ?? []).includes('"#f_'), "no step relies on the page's changing ids")

  // ---------- 3. replay as a scheduled task: no model involved
  const task = await api('tasks.save', {
    name: '每日导出',
    kind: 'flow',
    macroId: flow.id,
    params: { order_no: 'B-2002' },
    prompt: '',
    modelId: null,
    cron: null,
    enabled: true,
  })
  let calls = agentCalls()
  let r = await runTask(task.id)
  ok(r?.status === 'success' && exported.includes('B-2002'), `the flow replays with a new parameter (${r?.status}${r?.error ? `: ${r.error}` : ''})`)
  ok(agentCalls() === calls && r?.summary?.includes('未调用模型'), 'the replay made 0 model calls')

  // ---------- 4. the system is redesigned: the replay breaks, the agent finishes, the flow is updated
  await fetch('http://127.0.0.1:38992/admin/v2')
  calls = agentCalls()
  r = await runTask(task.id)
  ok(r?.status === 'success' && agentCalls() > calls, 'after the redesign the replay broke and the agent took over')
  // (the task still has B-2002: the agent exported it again on the new page)
  ok(exported.filter((x) => x === 'B-2002').length === 2, 'the job still got done on the new page')
  const repaired = await until(async () => (await win.evaluate(() => window.__repaired))[0])
  ok(repaired?.macroId === flow.id && repaired.version === 2, `the flow was updated (version ${repaired?.version}, from step ${repaired?.step})`)
  const versions = await api('flows.versions', flow.id)
  ok(versions[0]?.source === 'repair' && versions[1]?.source === 'agent', 'the repair is recorded as a new version')

  // ---------- 5. the updated flow replays without the model again
  await api('tasks.save', { ...task, id: task.id, params: { order_no: 'D-4004' } })
  calls = agentCalls()
  r = await runTask(task.id)
  ok(r?.status === 'success' && exported.includes('D-4004') && agentCalls() === calls, 'on the new page the updated flow replays with 0 model calls')
  const stats = (await api('flows.stats'))[flow.id]
  ok(stats?.runs === 3 && stats.repaired === 1 && stats.version === 2, `stats: ${JSON.stringify(stats)}`)

  // ---------- 6. the macros page shows it
  await win.evaluate((id) => (window.location.hash = `#/macros?id=${id}`), flow.id)
  await win.waitForSelector('[data-testid=flow-stats]', { timeout: 5000 })
  ok((await win.textContent('[data-testid=flow-stats]')).includes('自动修复 1 次'), 'the flow page shows replays and repairs')
  await win.getByRole('button', { name: /版本/ }).first().click()
  await win.waitForSelector('[data-testid=macro-version]', { timeout: 3000 })
  ok((await win.$$('[data-testid=macro-version]')).length === 2, 'its version history lists both versions')
  await sleep(400)
  await win.screenshot({ path: join(out, 'flow-versions.png') })
} catch (e) {
  await win.screenshot({ path: join(out, 'flows-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  site.close()
}
