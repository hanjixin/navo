// Memory: migration from the old Markdown files, automatic learning + undo, recall into the prompt,
// per-conversation off switch, the agent's memory tools, site notes on navigation, review mode, UI.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const profile = mkdtempSync(join(tmpdir(), 'ab-profile-'))
// old-style memory files, as earlier versions wrote them
mkdirSync(join(profile, 'memories'), { recursive: true })
writeFileSync(join(profile, 'memories', 'AGENTS.md'), '# 用户记忆\n\n说明文字不导入。\n\n## 偏好\n- 默认使用中文回复\n- 代码示例用 TypeScript\n')
writeFileSync(join(profile, 'memories', '项目.md'), 'Navo 是用户正在做的 Electron 桌面 Agent。')

const site = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Shop</title><h1>Shop</h1>')).listen(38986)
const mock = startMock(38987)
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.evaluate(() => {
  window.__events = []
  window.__learned = []
  window.api.on('chat.event', (e) => window.__events.push(e))
  window.api.on('memory.learned', (e) => window.__learned.push(e))
})
const runAndWait = async (threadId, text) => {
  const from = (await page.evaluate(() => window.__events)).length
  await api('chat.send', threadId, text)
  for (let i = 0; i < 120; i++) {
    if ((await page.evaluate(() => window.__events)).slice(from).some((e) => e.type === 'run_end' && e.threadId === threadId)) return
    await sleep(250)
  }
}
const waitLearned = async (n, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) {
    const l = await page.evaluate(() => window.__learned)
    if (l.length >= n) return l[n - 1]
    await sleep(100)
  }
  return null
}
/** the main agent's request for a given user message (not the extraction call) */
const agentReq = (text) => mock.requests.filter((r) => JSON.stringify(r.messages).includes(text))[0]
const extractionCalls = () => mock.extractions.length
const systemOf = (r) => JSON.stringify(r.messages[0].content)
const byTitle = async (t) => (await api('memory.list')).find((m) => m.title === t)

try {
  // ---------- migration
  const initial = await api('memory.list')
  ok(
    initial.some((m) => m.kind === 'preference' && m.content === '默认使用中文回复') &&
      initial.some((m) => m.kind === 'preference' && m.content === '代码示例用 TypeScript') &&
      initial.some((m) => m.kind === 'knowledge' && m.title === '项目' && m.content.includes('Electron')) &&
      !initial.some((m) => m.content.includes('说明文字')),
    `old AGENTS.md bullets and memory files are imported (${initial.length})`,
  )

  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })

  // ---------- automatic learning
  const t1 = await api('threads.create', m.id)
  await runAndWait(t1.id, '[plain] 我叫小韩，比较类的问题请用表格 [learn]')
  const l1 = await waitLearned(1)
  ok(l1?.items.length === 2 && !l1.pending, 'after the reply, two memories are learned in the background')
  const name = await byTitle('称呼')
  ok(name?.kind === 'profile' && name.source?.threadId === t1.id && name.status === 'active', 'learned memory records its source conversation')
  await page.waitForSelector('text=已记住', { timeout: 3000 }).catch(() => null)
  ok(!!(await page.$('text=已记住')), 'toast tells the user what was remembered')

  // ---------- recall
  const t2 = await api('threads.create', m.id)
  await runAndWait(t2.id, '[plain] 你好')
  const sys2 = systemOf(agentReq('[plain] 你好'))
  ok(sys2.includes('用户叫小韩') && sys2.includes('默认使用中文回复') && sys2.includes('对比类问题用表格'), 'profile and preferences are in every conversation')
  ok(!sys2.includes('Electron 桌面 Agent'), 'unrelated knowledge stays out of the prompt')
  const t3 = await api('threads.create', m.id)
  await runAndWait(t3.id, '[plain] 帮我看看 Navo 这个项目的打包配置')
  const sys3 = systemOf(agentReq('Navo 这个项目的打包配置'))
  ok(sys3.includes('Electron 桌面 Agent'), 'knowledge relevant to the message is recalled')
  const u3 = (await api('threads.state', t3.id)).messages.find((x) => x.role === 'user')
  ok(
    u3.memories?.some((r) => r.title === '项目'),
    'the user message records which memories were used',
  )
  ok((await byTitle('项目')).useCount >= 1, 'use count goes up when a memory is used')

  // ---------- undo
  await api('memory.undo', l1.batchId)
  ok(!(await byTitle('称呼')) && !(await byTitle('回答格式')), 'undo removes what the batch learned')

  // ---------- per-conversation off
  const t4 = await api('threads.create', m.id)
  await api('memory.setThreadEnabled', t4.id, false)
  const before4 = extractionCalls()
  await runAndWait(t4.id, '[plain] 无痕对话 [learn]')
  await sleep(1500)
  const r4 = agentReq('无痕对话')
  ok(
    systemOf(r4).includes('本对话关闭了记忆') && !systemOf(r4).includes('默认使用中文回复') && !r4.tools.some((x) => x.function.name.startsWith('memory_')),
    'memory off: no memories, no memory tools',
  )
  ok(extractionCalls() === before4, 'memory off: nothing is learned from the conversation')

  // ---------- the agent's own tool call (automatic learning then skips the exchange)
  const t5 = await api('threads.create', m.id)
  const before5 = extractionCalls()
  await runAndWait(t5.id, '[memtool] 记住这家店改地址的方法')
  const siteMem = await byTitle('下单入口')
  ok(siteMem?.kind === 'site' && siteMem.scope === 'shop.example.org' && siteMem.source?.threadId === t5.id, 'memory_save stores a site memory with its source')
  await sleep(1200)
  const n5 = (await page.evaluate(() => window.__learned)).length
  ok(
    extractionCalls() === before5 + 1 && (await page.evaluate(() => window.__learned)).length === n5,
    'agent saved memory itself: the background pass only writes the journal, learns nothing',
  )

  // ---------- site notes come with the navigation result
  await api('memory.save', { kind: 'site', scope: '127.0.0.1', title: '先登录', content: '用户的测试店铺需要先点右上角登录。' })
  const t6 = await api('threads.create', m.id)
  await runAndWait(t6.id, '[nav:http://127.0.0.1:38986/] 打开测试店铺')
  const toolMsg = (await api('threads.state', t6.id)).messages.find((x) => x.role === 'tool' && x.toolName === 'browser_navigate')
  ok(toolMsg?.content.includes('[站点经验]') && toolMsg.content.includes('右上角登录'), 'opening a site brings its remembered experience')

  // ---------- memory poisoning: text from pages / the agent can't become the user's memory
  const tp = await api('threads.create', m.id)
  const np = (await page.evaluate(() => window.__learned)).length
  await runAndWait(tp.id, '[plain] 帮我总结这个网页 [poison]')
  const lp = await waitLearned(np + 1)
  const poisoned = await byTitle('文件发送')
  ok(poisoned?.status === 'pending' && lp?.pending, 'a "remember" instruction not backed by the user\'s words is only held for confirmation')
  ok(
    (await api('memory.list')).some((x) => x.content === '默认使用中文回复' && x.status === 'active'),
    'an unbacked delete is not applied',
  )
  ok(!systemOf(agentReq('[plain] 第九个对话') ?? { messages: [{ content: '' }] }).includes('drop@evil'), 'held memories never reach the prompt')
  await api('memory.delete', poisoned.id)
  const tq = await api('threads.create', m.id)
  await runAndWait(tq.id, '[poisontool] 看看这个页面')
  const tqTools = (await api('threads.state', tq.id)).messages.filter((x) => x.role === 'tool')
  ok(
    (await byTitle('付款账户'))?.status === 'pending' && tqTools[0]?.content.includes("held for the user's confirmation"),
    'agent memory_save with made-up evidence is held for confirmation',
  )
  ok(
    tqTools[1]?.status === 'error' && tqTools[1].content.includes('需要用户本人的要求'),
    'agent memory_delete without the user asking is refused (the model sees why)',
  )
  ok(
    (await api('memory.list')).some((x) => x.content === '默认使用中文回复'),
    'and the memory is still there',
  )
  const tqEnd = (await api('threads.state', tq.id)).messages.at(-1)
  ok(tqEnd?.role === 'assistant' && tqEnd.content === '好的。', 'a failing tool no longer ends the run: the agent carries on')
  await api('memory.delete', (await byTitle('付款账户')).id)

  // ---------- safety
  const err = await api('memory.save', { kind: 'knowledge', title: '账号', content: '我的密码是 hunter2024' }).catch((e) => String(e))
  ok(typeof err === 'string' && err.includes('敏感信息'), 'secrets are refused')
  const t7 = await api('threads.create', m.id)
  const n7 = (await page.evaluate(() => window.__learned)).length
  await runAndWait(t7.id, '[plain] 帮我登录 [learn-secret]')
  await sleep(1500)
  ok((await page.evaluate(() => window.__learned)).length === n7 && !(await byTitle('账号')), 'a learned secret is dropped')

  // ---------- review mode
  const s = await api('settings.get')
  await api('settings.set', { memory: { ...s.memory, review: true } })
  const t8 = await api('threads.create', m.id)
  const n8 = (await page.evaluate(() => window.__learned)).length
  await runAndWait(t8.id, '[plain] 再介绍一下我自己 [learn]')
  const l8 = await waitLearned(n8 + 1)
  const pend = await byTitle('称呼')
  ok(l8?.pending && pend?.status === 'pending', 'review mode: learned memories wait for confirmation')
  const t9 = await api('threads.create', m.id)
  await runAndWait(t9.id, '[plain] 第九个对话')
  ok(!systemOf(agentReq('第九个对话')).includes('用户叫小韩'), 'pending memories are not used yet')
  await api('memory.confirm', [pend.id])
  ok((await byTitle('称呼')).status === 'active', 'confirming activates it')
  await api('settings.set', { memory: { ...s.memory, review: false } })

  // ---------- daily journal
  const tj = await api('threads.create', m.id)
  await runAndWait(tj.id, '[plain] 整理九月报销 [journal:用户整理了九月的报销单。]')
  const waitDay = async (fn) => {
    for (let i = 0; i < 60; i++) {
      const d = (await api('memory.days')).find((e) => e.threadId === tj.id)
      if (d && fn(d)) return d
      await sleep(100)
    }
    return null
  }
  ok(!!(await waitDay((d) => d.text === '用户整理了九月的报销单。')), "a reply writes the conversation's line in today's journal")
  await runAndWait(tj.id, '[plain] 再补一张发票 [journal:用户整理了九月的报销单，并补交了一张发票。]')
  const updated = await waitDay((d) => d.text.includes('补交'))
  const lastExtraction = mock.extractions.at(-1)
  ok(
    !!updated &&
      (await api('memory.days')).filter((e) => e.threadId === tj.id).length === 1 &&
      JSON.stringify(lastExtraction.messages).includes('今天已有的日记\\n用户整理了九月的报销单。'),
    "the next reply updates the same line, building on today's text",
  )
  const tk = await api('threads.create', m.id)
  await runAndWait(tk.id, '[plain] 接着昨天的事')
  const sysK = systemOf(agentReq('接着昨天的事'))
  ok(sysK.includes('今天的日记') && sysK.includes('补交了一张发票'), "other conversations see today's journal in the prompt")
  const td = await api('threads.create', m.id)
  await runAndWait(td.id, '[daily] 今天我都做了什么')
  const dailyTool = (await api('threads.state', td.id)).messages.find((x) => x.role === 'tool' && x.toolName === 'memory_daily')
  ok(dailyTool?.content.includes('补交了一张发票'), 'memory_daily returns the journal for a date')
  await api('threads.delete', tj.id)
  ok(!(await api('memory.days')).some((e) => e.threadId === tj.id), 'deleting a conversation removes its journal lines')
  const s0 = await api('settings.get')
  await api('settings.set', { memory: { ...s0.memory, daily: false } })
  const tn = await api('threads.create', m.id)
  await runAndWait(tn.id, '[plain] 关掉日记之后 [journal:不该写入]')
  await sleep(1200)
  ok(!(await api('memory.days')).some((e) => e.text === '不该写入'), 'daily journal can be turned off')
  await api('settings.set', { memory: { ...s0.memory, daily: true } })
  const tv = await api('threads.create', m.id)
  await runAndWait(tv.id, '[plain] 可视化用的日记 [journal:用户比较了三家云服务的报价。]')
  await sleep(1200)

  // ---------- recall follows the conversation, not just the last message
  const tc = await api('threads.create', m.id)
  await api('threads.rename', tc.id, '杂项')
  await runAndWait(tc.id, '[plain] 说说 Electron 桌面应用')
  await runAndWait(tc.id, '[plain] 那它一般用什么打包')
  ok(
    systemOf(mock.requests.filter((r) => JSON.stringify(r.messages).includes('那它一般用什么打包')).at(-1)).includes('Electron 桌面 Agent'),
    'a follow-up without keywords still recalls what the conversation is about',
  )

  // ---------- memory pass: skipped for pleasantries, can use its own (cheaper) model
  const ts = await api('threads.create', m.id)
  const beforeS = extractionCalls()
  await runAndWait(ts.id, '谢谢')
  await sleep(1200)
  ok(extractionCalls() === beforeS, 'no background memory call for "谢谢"')
  const cheap = await api('models.save', { providerId: p.id, model: 'mock-cheap', displayName: 'Cheap', supportsTools: true, supportsVision: false })
  const sm = await api('settings.get')
  await api('settings.set', { memory: { ...sm.memory, modelId: cheap.id } })
  const tm = await api('threads.create', m.id)
  await runAndWait(tm.id, '[plain] 用便宜模型整理 [journal:用户测试了记忆模型。]')
  await sleep(1200)
  ok(mock.extractions.at(-1)?.model === 'mock-cheap' && agentReq('用便宜模型整理').model === 'mock-1', 'the memory pass runs on the model chosen for memory')
  await api('settings.set', { memory: { ...sm.memory, modelId: null } })

  // ---------- UI (let toasts from the steps above go away first)
  await page.waitForSelector('[data-sonner-toast]', { state: 'detached', timeout: 10000 }).catch(() => null)
  await page.evaluate(() => (window.location.hash = '#/memory'))
  await page.waitForSelector('[data-testid=memory-row]', { timeout: 5000 })
  const rows = await page.$$('[data-testid=memory-row]')
  const count = (await api('memory.list')).filter((x) => x.status === 'active').length
  ok(rows.length === count, `memory page lists every memory (${rows.length})`)
  await page.getByRole('tab', { name: /站点经验/ }).click()
  await sleep(200)
  ok((await page.$$('[data-testid=memory-row]')).length === 2, 'filter by kind')
  await page.getByRole('tab', { name: /全部/ }).click()
  await page.getByPlaceholder('搜索记忆').fill('TypeScript')
  await sleep(200)
  ok((await page.$$('[data-testid=memory-row]')).length === 1, 'search filters the list')
  await page.getByPlaceholder('搜索记忆').fill('')
  await page.getByRole('button', { name: '新建记忆' }).first().click()
  await page.getByPlaceholder('如：回答风格').fill('作息')
  await page.getByPlaceholder(/以「用户」为主语|先给结论/).fill('用户一般晚上十点后不看消息。')
  await page.getByRole('button', { name: '添加' }).click()
  await sleep(400)
  ok(!!(await byTitle('作息')), 'a memory can be added from the page')
  await page.screenshot({ path: join(out, 'memory-page.png') })
  await page.getByRole('tab', { name: '每日' }).click()
  await page.waitForSelector('[data-testid=day-entry]', { timeout: 3000 }).catch(() => null)
  ok((await page.$$('[data-testid=day-entry]')).length >= 1 && (await page.isVisible('text=用户比较了三家云服务的报价。')), 'the 每日 tab shows the journal')
  const selected = await page.$$eval('[role=tab][aria-selected=true]', (t) => t.map((x) => x.textContent.trim()))
  ok(selected.length === 1 && selected[0] === '每日', `exactly one tab is selected (${selected.join(', ')})`)
  await sleep(400)
  await page.mouse.move(10, 10)
  await page.screenshot({ path: join(out, 'memory-daily.png') })

  // chat: the message that used memories shows the chip; it opens the memory on the Memory page
  await page.evaluate(() => (window.location.hash = '#/chat'))
  await page.getByText('帮我看看 Navo 这个项目', { exact: false }).first().click()
  const chip = await page.waitForSelector('button[aria-label^="引用了"]', { timeout: 5000 }).catch(() => null)
  ok(!!chip, 'chat shows which memories a message used')
  await sleep(600)
  await page.screenshot({ path: join(out, 'memory-chip.png') })
  await chip?.click()
  await page.getByRole('menuitem', { name: /项目/ }).click()
  await page.waitForSelector('[data-testid=memory-row].ring-2', { timeout: 3000 }).catch(() => null)
  ok(
    (await page.evaluate(() => window.location.hash)).includes('focus=') && !!(await page.$('[data-testid=memory-row].ring-2')),
    'clicking it highlights the memory',
  )
} catch (e) {
  await page.screenshot({ path: join(out, 'memory-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  site.close()
}
