// Covers the robustness work: out-of-process agent, snapshots/diffs, loop guard, page dialogs,
// file chooser, downloads, beforeunload, login popups, per-conversation tabs, model list fallback,
// reasoning display, regenerate / edit / always-allow, encrypted MCP secrets, plugin isolation.
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMock } from './mock-llm.mjs'

// Playwright auto-dismisses page dialogs it sees; for dialogs Electron already handled that races and throws inside Playwright
process.on('unhandledRejection', (e) => {
  if (/Page.handleJavaScriptDialog/.test(String(e?.message ?? e))) return
  console.log('FAIL unhandled', e)
  process.exitCode = 1
})
const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const downloads = mkdtempSync(join(tmpdir(), 'ab-dl-'))
const mock = startMock(38994)
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData, AB_DOWNLOADS: downloads } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const tool = (name, args = {}) => api('dev.invokeTool', name, args)
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const html = (body, title = 'T') => 'data:text/html,' + encodeURIComponent(`<!doctype html><meta charset=utf-8><title>${title}</title>${body}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})
const events = () => page.evaluate(() => window.__events)
const waitRunEnd = async (threadId, from = 0) => {
  for (let i = 0; i < 80; i++) {
    if ((await events()).slice(from).some((e) => e.type === 'run_end' && e.threadId === threadId)) return true
    await sleep(250)
  }
  return false
}

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })

  // ---------- 10. agent runs out of process, UI stays responsive, host restarts after a crash
  const t0 = await api('threads.create', m.id)
  await api('chat.send', t0.id, '[slow] 说点什么')
  await sleep(600)
  const metrics = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((x) => x.type === 'Utility')
      .map((x) => `${x.name}`),
  )
  ok(
    metrics.some((n) => /Navo Agent/.test(n ?? '')),
    `agent runs in its own utility process (${metrics.join(', ')})`,
  )
  let worst = 0
  for (let i = 0; i < 10; i++) {
    const s = Date.now()
    await api('browser.state')
    worst = Math.max(worst, Date.now() - s)
    await sleep(100)
  }
  ok(worst < 150, `main process responsive during a streaming run (worst IPC ${worst}ms)`)
  await api('chat.stop', t0.id)
  await waitRunEnd(t0.id)
  await app.evaluate(({ app }) => {
    const pid = app.getAppMetrics().find((x) => x.type === 'Utility' && /Navo Agent/.test(x.name ?? ''))?.pid
    if (!pid) throw new Error('agent host pid not found')
    process.kill(pid, 'SIGKILL')
  })
  await sleep(500)
  const t0b = await api('threads.create', m.id)
  const from0 = (await events()).length
  await api('chat.send', t0b.id, '[plain] 你好')
  await waitRunEnd(t0b.id, from0)
  ok((await api('threads.state', t0b.id)).messages.at(-1)?.content.includes('好的'), 'agent process restarts automatically after a crash')

  // ---------- 1. budgeted snapshot + diffs
  const nav = Array.from({ length: 150 }, (_, i) => `<a href="/n${i}">导航链接${i}</a>`).join(' ')
  const results = Array.from({ length: 8 }, (_, i) => `<li><h2><a href="https://r${i}.example">搜索结果 ${i}</a></h2><p>摘要 ${i}</p></li>`).join('')
  const snap = await tool('browser_navigate', {
    url: html(
      `<header><nav>${nav}</nav><form><input type=search name=q aria-label=搜索></form></header><main><ol>${results}</ol><button id=more onclick="this.insertAdjacentHTML('afterend','<p>新加载的内容</p>')">更多</button></main>`,
      'Search',
    ),
  })
  ok(snap.length < 7000, `default snapshot stays within budget (${snap.length} chars)`)
  ok(
    /searchbox|textbox "搜索"/.test(snap) && snap.includes('搜索结果 7') && !snap.includes('导航链接42'),
    'main content + header search box kept, nav links folded',
  )
  ok(/150 个链接已折叠/.test(snap), 'folded links are summarised')
  const full = await tool('browser_snapshot', { scope: 'all' })
  ok(full.includes('导航链接42'), 'scope:"all" includes folded links')
  const ref = /\[(e\d+)\] button "更多"/.exec(snap)?.[1]
  const diff = await tool('browser_click', { ref })
  ok(diff.includes('新加载的内容') && !diff.includes('搜索结果 3') && /新增\/更新 \d+ 行/.test(diff), 'click returns only what changed')

  // ---------- 1. loop guard
  const tl = await api('threads.create', m.id)
  const fromL = (await events()).length
  await api('chat.send', tl.id, '[loop]')
  await waitRunEnd(tl.id, fromL)
  const lst = await api('threads.state', tl.id)
  ok(
    lst.messages.some((x) => x.role === 'tool' && x.content.includes('已拦截')),
    'identical repeated tool calls are refused by the loop guard',
  )

  // ---------- 2. dialogs, beforeunload, file chooser, downloads
  const dlg = await tool('browser_navigate', {
    url: html(`<button id=c onclick="document.title='confirm:'+confirm('确定删除？')">删除</button><button id=a onclick="alert('保存成功')">提示</button>`),
  })
  const cRef = /\[(e\d+)\] button "删除"/.exec(dlg)[1]
  const aRef = /\[(e\d+)\] button "提示"/.exec(dlg)[1]
  const r1 = await tool('browser_click', { ref: cRef })
  ok(r1.includes('确认框') && r1.includes('确定删除') && r1.includes('取消'), 'confirm() does not block; agent told it was dismissed')
  ok((await api('browser.state')).tabs.find((t) => t.active).title === 'confirm:false', 'page received the dismissed answer')
  await tool('browser_set_dialog_policy', { confirm: true })
  await tool('browser_click', { ref: cRef })
  ok((await api('browser.state')).tabs.find((t) => t.active).title === 'confirm:true', 'dialog policy lets the agent confirm deliberately')
  const r2 = await tool('browser_click', { ref: aRef })
  ok(r2.includes('提示框') && r2.includes('保存成功'), 'alert() reported to the agent')

  await tool('browser_navigate', {
    url: html(`<script>addEventListener('beforeunload',(e)=>{e.preventDefault();e.returnValue='x'})</script><button onclick="1">x</button>`),
  })
  await tool('browser_click', { ref: 'e1' }).catch(() => null) // user activation so beforeunload fires
  const leave = await Promise.race([tool('browser_navigate', { url: html('<h1>left</h1>', 'Left') }), sleep(8000).then(() => 'TIMEOUT')])
  ok(typeof leave === 'string' && leave.includes('Left'), 'beforeunload prompt does not trap the agent')

  const up = join(tmpdir(), 'navo-upload.txt')
  writeFileSync(up, 'hello')
  const fc = await tool('browser_navigate', { url: html(`<input type=file id=f onchange="document.title='got:'+this.files[0].name">`) })
  const fRef = /\[(e\d+)\] textbox/.exec(fc)?.[1] ?? 'e1'
  const r3 = await tool('browser_click', { ref: fRef })
  ok(r3.includes('文件选择框'), 'native file chooser intercepted and reported')
  await tool('browser_upload_file', { files: [up] })
  ok((await api('browser.state')).tabs.find((t) => t.active).title === 'got:navo-upload.txt', 'upload fulfils the pending chooser without a ref')

  const dl = await tool('browser_navigate', {
    url: html(`<a id=d download="report.txt" href="data:text/plain;base64,${Buffer.from('report').toString('base64')}">下载报告</a>`),
  })
  await tool('browser_click', { ref: /\[(e\d+)\] link "下载报告"/.exec(dl)[1] })
  await sleep(800)
  ok(readdirSync(downloads).includes('report.txt'), 'downloads saved automatically without a dialog')
  ok((await tool('browser_downloads')).includes('report.txt'), 'downloads listed for the agent')

  // ---------- 3. login popups stay real windows, plain _blank links become tabs
  const tabsBefore = (await api('browser.state')).tabs.length
  const pop = await tool('browser_navigate', {
    url: html(`<button onclick="window.open('about:blank','login','width=420,height=560')">登录</button><a target=_blank href="about:blank#x">新页</a>`),
  })
  await tool('browser_click', { ref: /\[(e\d+)\] button "登录"/.exec(pop)[1] })
  await sleep(600)
  const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  ok(wins === 2 && (await api('browser.state')).tabs.length === tabsBefore, 'sized window.open opens a real popup window (opener kept)')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.getParentWindow())
      .forEach((w) => w.close()),
  )
  await tool('browser_click', { ref: /\[(e\d+)\] link "新页"/.exec(pop)[1] })
  await sleep(500)
  ok((await api('browser.state')).tabs.length === tabsBefore + 1, 'target=_blank link opens a new tab')

  // ---------- 4. concurrent conversations drive separate tabs
  const ta = await api('threads.create', m.id)
  const tb = await api('threads.create', m.id)
  const fromC = (await events()).length
  await api('chat.send', ta.id, '[navslow:Alpha]')
  await sleep(300)
  await api('chat.send', tb.id, '[navslow:Beta]')
  // both runs must have opened their pages; poll instead of a fixed wait (slow under full-suite load)
  let tabA, tabB
  let sawRunningA = false
  let sawRunningB = false
  for (let i = 0; i < 40; i++) {
    const st = await api('browser.state')
    tabA = st.tabs.find((t) => t.agent?.threadId === ta.id)
    tabB = st.tabs.find((t) => t.agent?.threadId === tb.id)
    sawRunningA ||= !!tabA?.agent.running
    sawRunningB ||= !!tabB?.agent.running
    if (tabA?.title.includes('Alpha') && tabB?.title.includes('Beta') && sawRunningA && sawRunningB) break
    await sleep(100)
  }
  ok(tabA && tabB && tabA.id !== tabB.id && tabA.title.includes('Alpha') && tabB.title.includes('Beta'), 'two running conversations use two different tabs')
  ok(sawRunningA && sawRunningB, 'tabs show which conversation is driving them')
  await waitRunEnd(ta.id, fromC)
  await waitRunEnd(tb.id, fromC)

  // ---------- 5. model list fallback (Anthropic-compatible base with a path)
  const pa = await api('providers.save', { type: 'anthropic', name: 'compat', baseURL: mock.url.replace('/v1', '/anthropic'), apiKey: 'x' })
  const list = await api('providers.fetchModels', pa.id)
  ok(list.includes('mock-1'), `model list found via fallback URLs (${list.join(',')})`)

  // ---------- 6. reasoning shown separately from the answer
  const tr = await api('threads.create', m.id)
  const fromR = (await events()).length
  await api('chat.send', tr.id, '[think] 问题')
  await waitRunEnd(tr.id, fromR)
  const rEvents = (await events()).slice(fromR)
  const rs = await api('threads.state', tr.id)
  ok(
    rEvents.some((e) => e.type === 'token' && e.reasoning) && rs.messages.at(-1)?.reasoning?.includes('先分析问题'),
    'reasoning streamed and persisted separately',
  )
  ok(rs.messages.at(-1)?.content === '答案是 42', 'answer text excludes reasoning')

  // ---------- 7. regenerate, edit & resend, always allow
  const tg = await api('threads.create', m.id)
  let from = (await events()).length
  await api('chat.send', tg.id, '[plain] 第一问')
  await waitRunEnd(tg.id, from)
  const firstUser = (await api('threads.state', tg.id)).messages.find((x) => x.role === 'user')
  from = (await events()).length
  await api('chat.regenerate', tg.id, firstUser.id)
  await waitRunEnd(tg.id, from)
  let gs = await api('threads.state', tg.id)
  ok(
    gs.messages.filter((x) => x.role === 'user').length === 1 && gs.messages.at(-1)?.role === 'assistant',
    'regenerate replaces the answer instead of appending',
  )
  from = (await events()).length
  await api('chat.send', tg.id, '[plain] 第二问')
  await waitRunEnd(tg.id, from)
  gs = await api('threads.state', tg.id)
  const second = gs.messages.filter((x) => x.role === 'user')[1]
  from = (await events()).length
  await api('chat.regenerate', tg.id, second.id, '[plain] 改过的第二问')
  await waitRunEnd(tg.id, from)
  gs = await api('threads.state', tg.id)
  const users = gs.messages.filter((x) => x.role === 'user').map((x) => x.content)
  ok(users.length === 2 && users[0].includes('第一问') && users[1].includes('改过的第二问'), `edit & resend branches from that message (${users.join(' | ')})`)

  await api('settings.set', { approvalTools: ['browser_navigate'] })
  const tw = await api('threads.create', m.id)
  from = (await events()).length
  await api('chat.send', tw.id, '[navslow:Gamma]')
  await waitRunEnd(tw.id, from)
  ok(
    (await events()).slice(from).some((e) => e.type === 'interrupt'),
    'approval requested the first time',
  )
  from = (await events()).length
  await api('chat.resume', tw.id, [{ type: 'approve' }], ['browser_navigate'])
  await waitRunEnd(tw.id, from)
  from = (await events()).length
  await api('chat.send', tw.id, '[navslow:Delta]')
  await waitRunEnd(tw.id, from)
  ok(!(await events()).slice(from).some((e) => e.type === 'interrupt'), '"always allow" skips approval for the rest of the conversation')
  await api('settings.set', { approvalTools: ['browser_eval', 'browser_upload_file'] })

  // ---------- 8. MCP env / headers never stored in SQLite
  const srv = await api('mcp.save', {
    name: 'secret-test',
    transport: 'http',
    url: 'http://127.0.0.1:1/mcp',
    headers: { Authorization: 'Bearer TOPSECRET' },
    env: null,
    enabled: false,
  })
  const row = execFileSync('sqlite3', ['-readonly', join(userData, 'agent.db'), `select coalesce(headers,'NULL') from mcp_servers where id='${srv.id}'`])
    .toString()
    .trim()
  const dbFile = execFileSync('sh', ['-c', `cat "${join(userData, 'agent.db')}"* | grep -c TOPSECRET || true`])
    .toString()
    .trim()
  ok(row === 'NULL' && dbFile === '0', 'MCP headers are not stored in plaintext in the database')
  ok((await api('mcp.list')).find((x) => x.id === srv.id)?.headers?.Authorization === 'Bearer TOPSECRET', 'MCP headers readable through the keychain')

  // ---------- 9. plugins run in their own isolated world
  await api('plugins.create', 'probe', 'Probe')
  await api(
    'plugins.writeFile',
    'probe',
    'manifest.json',
    JSON.stringify({
      id: 'probe',
      name: 'Probe',
      matches: ['<all_urls>'],
      contentScript: 'content.js',
      actions: [{ name: 'inspect', description: 'x', parameters: { type: 'object', properties: {} } }],
    }),
  )
  await api(
    'plugins.writeFile',
    'probe',
    'content.js',
    `agentPlugin.register('inspect', async () => ({ agentRuntime: typeof window.__agent, bridge: typeof window.__agentBridge, h1: document.querySelector('h1')?.textContent }))`,
  )
  // a local page (don't depend on external sites: example.com dropped its <h1>)
  const site = createServer((_, res) =>
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Probe</title><h1>Probe Page</h1>'),
  ).listen(38985)
  await tool('browser_navigate', { url: 'http://127.0.0.1:38985/' }).catch(() => null)
  const probe = await api('plugins.runAction', 'probe', 'inspect', {}).catch((e) => ({ error: String(e) }))
  ok(
    probe.agentRuntime === 'undefined' && probe.bridge === 'undefined' && probe.h1 === 'Probe Page',
    `plugin cannot see the agent runtime or IPC bridge (${JSON.stringify(probe)})`,
  )
  site.close()
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
