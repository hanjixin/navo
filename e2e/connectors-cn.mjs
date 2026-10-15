// Office connectors used in China: group bots (企业微信 / 钉钉 / 飞书, with their signing schemes)
// connected through a form, used by the agent with approval, and as targets of monitor alerts.
import { _electron as electron } from 'playwright'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const PORT = 38988
const BASE = `http://127.0.0.1:${PORT}`
const DING_SECRET = 'SECding'
const FEISHU_SECRET = 'feishu-s'
const received = { wecom: [], dingtalk: [], feishu: [] }
let price = 1599
const site = createServer(async (req, res) => {
  const url = new URL(req.url, BASE)
  let body = ''
  for await (const c of req) body += c
  const json = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o))
  if (url.pathname === '/wecom') return (received.wecom.push(JSON.parse(body)), json({ errcode: 0, errmsg: 'ok' }))
  if (url.pathname === '/dingtalk') {
    // DingTalk checks timestamp + sign like this
    const ts = url.searchParams.get('timestamp')
    const ok = url.searchParams.get('sign') === createHmac('sha256', DING_SECRET).update(`${ts}\n${DING_SECRET}`).digest('base64')
    if (!ok) return json({ errcode: 310000, errmsg: 'sign not match' })
    return (received.dingtalk.push(JSON.parse(body)), json({ errcode: 0, errmsg: 'ok' }))
  }
  if (url.pathname === '/feishu') {
    const b = JSON.parse(body)
    const ok = b.sign === createHmac('sha256', `${b.timestamp}\n${FEISHU_SECRET}`).update('').digest('base64')
    if (!ok) return json({ code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' })
    return (received.feishu.push(b), json({ code: 0, msg: 'success' }))
  }
  if (url.pathname === '/product')
    return res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><meta charset="utf-8"><main><h1>显示器</h1><p>¥${price}</p></main>`)
  res.writeHead(404).end()
}).listen(PORT)

const mock = startMock(38989)
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')), AB_MEMORY_IDLE_MS: '600000', AB_ALLOW_ANY_WEBHOOK: '1' },
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
const fails = async (p) =>
  p.then(
    () => null,
    (e) => String(e.message ?? e),
  )
await win.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- the catalog
  await win.evaluate(() => (window.location.hash = '#/connectors'))
  await win.waitForSelector('text=国内办公', { timeout: 8000 })
  const page = await win.textContent('main')
  ok(
    ['飞书', '钉钉', '企业微信群机器人', '钉钉群机器人', '飞书群机器人', '邮箱', '日历（CalDAV）'].every((n) => page.includes(n)),
    'the office connectors are listed together',
  )

  // ---------- 企业微信 through the form
  const card = win
    .locator('div', { hasText: '企业微信群机器人' })
    .filter({ has: win.getByRole('button', { name: '连接' }) })
    .last()
  await card.getByRole('button', { name: '连接' }).click()
  await win.getByLabel('群名称（可选）').fill('研发群')
  await win.getByLabel('Webhook 地址').fill(`${BASE}/wecom?key=k1`)
  await win.screenshot({ path: join(out, 'connector-form.png') })
  await win.getByRole('dialog').getByRole('button', { name: '连接' }).click()
  await win.waitForSelector('text=已连接', { timeout: 8000 })
  const state = (await api('connectors.states')).find((s) => s.id === 'wecom-bot')
  ok(
    state?.connected && state.config?.name === '研发群' && !JSON.stringify(state).includes('k1'),
    'connected; the webhook (it holds the key) is not sent back to the page',
  )
  await win.getByRole('button', { name: '测试' }).click()
  await until(async () => received.wecom.length)
  ok(received.wecom[0]?.msgtype === 'markdown' && received.wecom[0].markdown.content.includes('Navo 测试消息'), '"测试" sends a markdown message to the group')

  // ---------- 钉钉 / 飞书 with signing
  await api('connectors.connect', 'dingtalk-bot', { webhook: `${BASE}/dingtalk?access_token=t`, secret: 'wrong' })
  ok(/310000[\s\S]*加签/.test((await fails(api('connectors.testNotify', 'dingtalk-bot'))) ?? ''), 'a wrong signing secret is explained')
  await api('connectors.connect', 'dingtalk-bot', { webhook: `${BASE}/dingtalk?access_token=t`, secret: DING_SECRET })
  await api('connectors.testNotify', 'dingtalk-bot')
  ok(received.dingtalk[0]?.markdown?.title === 'Navo 测试消息', 'DingTalk: signed message accepted')
  await api('connectors.connect', 'feishu-bot', { webhook: `${BASE}/feishu`, secret: FEISHU_SECRET })
  await api('connectors.testNotify', 'feishu-bot')
  ok(received.feishu[0]?.msg_type === 'interactive' && received.feishu[0].card.header.title.content === 'Navo 测试消息', 'Feishu: signed card accepted')
  // reconnecting with the secret left blank keeps it
  await api('connectors.connect', 'feishu-bot', { webhook: `${BASE}/feishu` })
  ok((await fails(api('connectors.testNotify', 'feishu-bot'))) === null, 'a secret left blank on a reconnect is kept')

  // ---------- the agent sends, after approval
  const t = await api('threads.create', m.id)
  await api('chat.send', t.id, '[bot:wecom_send_message] 把日报发到群里')
  const intr = await until(async () => (await win.evaluate(() => window.__events)).find((e) => e.type === 'interrupt'))
  ok(intr?.interrupt.actionRequests[0].name === 'wecom_send_message' && received.wecom.length === 1, 'sending to a group waits for approval')
  await api('chat.resume', t.id, [{ type: 'approve' }])
  await until(async () => received.wecom.length === 2)
  ok(received.wecom[1]?.markdown.content.includes('完成 **3** 项任务'), 'after approval the message reaches the group')

  // ---------- monitor alerts to a group
  const task = await api('tasks.save', {
    name: '显示器降价',
    kind: 'monitor',
    monitor: { url: `${BASE}/product`, condition: '低于 1500', action: 'notify', notifyConnector: 'feishu-bot' },
    prompt: '',
    modelId: null,
    cron: null,
    enabled: true,
  })
  await api('monitor.check', task.id)
  price = 1399
  const c = await api('monitor.check', task.id)
  await until(async () => received.feishu.length >= 3)
  const alert = received.feishu.at(-1)
  ok(
    c.triggered && alert?.card.header.title.content === '监控提醒：显示器降价' && alert.card.elements[0].content.includes('1399'),
    'a triggered monitor posts the alert to the Feishu group',
  )

  // ---------- mail and calendar say what is wrong
  const mailErr = await fails(
    api('connectors.connect', 'email', {
      provider: 'custom',
      address: 'me@example.com',
      password: 'x',
      imap_host: '127.0.0.1',
      imap_port: '1',
      smtp_host: '127.0.0.1',
      smtp_port: '1',
    }),
  )
  ok(/连不上邮件服务器/.test(mailErr ?? ''), `a mailbox that can't be reached is explained (${mailErr})`)
  const calErr = await fails(api('connectors.connect', 'caldav', { server: 'not a url', username: 'u', password: 'p' }))
  ok(/CalDAV 服务器地址/.test(calErr ?? ''), 'a CalDAV address is required')
  await win.screenshot({ path: join(out, 'connectors-cn.png') })
} catch (e) {
  await win.screenshot({ path: join(out, 'connectors-cn-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  site.close()
}
