import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMock } from './mock-llm.mjs'

const mock = startMock()
const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
await page.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  await api('settings.set', { devMode: true })
  const t = await api('threads.create', m.id)
  await api('chat.send', t.id, '打开页面并告诉我标题')
  for (let i = 0; i < 60; i++) {
    if ((await page.evaluate(() => window.__events)).some((e) => e.type === 'run_end')) break
    await page.waitForTimeout(500)
  }
  const evs = await page.evaluate(() => window.__events)
  const st = await api('threads.state', t.id)
  ok(!evs.some((e) => e.type === 'error'), `no errors ${JSON.stringify(evs.filter((e) => e.type === 'error'))}`)
  ok(evs.filter((e) => e.type === 'token').length >= 3, 'assistant text streamed as tokens')
  ok(
    st.messages.some((x) => x.role === 'tool' && x.toolName === 'browser_navigate' && x.content.includes('Hello Agent')),
    'browser tool result persisted in checkpoint',
  )
  ok(st.messages.at(-1)?.role === 'assistant' && st.messages.at(-1).content.includes('Hello Agent'), 'final answer persisted')
  const f = join(userData, 'workspace', 'answer.txt')
  ok(existsSync(f) && readFileSync(f, 'utf8') === 'Hello Agent', '/workspace/ routed to disk via CompositeBackend')
  const sys = JSON.stringify(mock.requests[0].messages[0].content)
  ok(sys.includes('默认使用中文回复') && sys.includes('## 记忆'), 'memories (default preference) injected into system prompt')
  ok(
    mock.requests[0].tools.some((x) => x.function.name === 'browser_click') && mock.requests[0].tools.some((x) => x.function.name === 'task'),
    'browser tools + subagent task tool offered to model',
  )
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0]?.getBounds() ?? null)
  const bstate = await api('browser.state')
  ok(
    bounds && bounds.width > 300 && bstate.tabs.find((x) => x.active)?.url.includes('Mock%20Page'),
    `page the agent opened is shown in the right panel (${JSON.stringify(bounds)})`,
  )

  // panel collapsed by the user → the agent's browser use shows up in the mini window (panel stays collapsed)
  await page.keyboard.press('ControlOrMeta+Backslash')
  await page.waitForTimeout(300)
  const t3 = await api('threads.create', m.id)
  await page.evaluate(() => (window.__events = []))
  await api('chat.send', t3.id, '再打开一次')
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => window.__events)).some((e) => e.type === 'run_end')) break
    await page.waitForTimeout(500)
  }
  ok(!(await page.$('[role=separator]')) && !!(await page.$('[data-testid=browser-mini]')), "collapsed panel: the agent's browsing shows in the mini window")

  const threads = await api('threads.list')
  ok(threads.find((x) => x.id === t.id)?.title === '打开页面并告诉我标题', 'thread auto-titled')
  ok(
    (await api('dev.traces', t.id)).some((x) => x.kind === 'llm'),
    'dev traces recorded',
  )

  // HITL: require approval for browser_navigate and check interrupt + resume
  await api('settings.set', { approvalTools: ['browser_navigate'] })
  mock.requests.length = 0
  const t2 = await api('threads.create', m.id)
  await page.evaluate(() => (window.__events = []))
  await api('chat.send', t2.id, '再来一次')
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => window.__events)).some((e) => e.type === 'run_end')) break
    await page.waitForTimeout(500)
  }
  let evs2 = await page.evaluate(() => window.__events)
  const intr = evs2.find((e) => e.type === 'interrupt')
  ok(intr?.interrupt.actionRequests[0].name === 'browser_navigate', 'approval interrupt raised')
  const pending = await api('threads.state', t2.id)
  ok(pending.interrupt?.actionRequests.length === 1, 'pending interrupt restored from checkpoint')
  await page.evaluate(() => (window.__events = []))
  await api('chat.resume', t2.id, [{ type: 'approve' }])
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => window.__events)).some((e) => e.type === 'run_end')) break
    await page.waitForTimeout(500)
  }
  const st2 = await api('threads.state', t2.id)
  ok(st2.messages.at(-1)?.content.includes('Hello Agent') && !st2.interrupt, 'resume after approval completes the run')
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
