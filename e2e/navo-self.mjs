// Navo's own agent uses the navo_* management tools in-process (no HTTP / token), with guard rails.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const mock = startMock(38985)
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'ab-home-')), AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')) },
})
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
const run = async (threadId, text) => {
  const from = (await page.evaluate(() => window.__events)).length
  await api('chat.send', threadId, text)
  for (let i = 0; i < 120; i++) {
    const evs = (await page.evaluate(() => window.__events)).slice(from)
    if (evs.some((e) => e.type === 'run_end' && e.threadId === threadId)) return evs
    await new Promise((r) => setTimeout(r, 250))
  }
  return []
}

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  // the external MCP server stays OFF: Navo's own agent must not depend on it
  ok(!(await api('navoMcp.status')).running, 'external MCP server is off')

  const t1 = await api('threads.create', m.id)
  await run(t1.id, '[navo-list] 有哪些模型')
  const firstReq = mock.requests.find((r) => JSON.stringify(r.messages).includes('[navo-list]'))
  const toolNames = firstReq.tools.map((t) => t.function.name)
  ok(
    ['navo_list_models', 'navo_save_skill', 'navo_add_mcp_server', 'navo_send_message', 'navo_list_connectors'].every((n) => toolNames.includes(n)),
    "navo_* tools offered to Navo's own agent (write tools included)",
  )
  const s1 = await api('threads.state', t1.id)
  ok(s1.messages.at(-1)?.content.includes('mock-1'), 'agent calls navo_list_models in-process (no server, no token)')

  const t2 = await api('threads.create', m.id)
  await run(t2.id, '[navo-delegate] 帮我派个子任务')
  const s2 = await api('threads.state', t2.id)
  ok(
    s2.messages.at(-1)?.content.includes('completed') && s2.messages.at(-1)?.content.includes('好的'),
    'navo_send_message delegates to a new conversation and returns its answer',
  )
  const child = (await api('threads.list')).find((t) => t.id !== t1.id && t.id !== t2.id)
  ok(!!child, 'delegated conversation is visible in the UI')
  const childReq = mock.requests.find((r) => r.messages.some((x) => x.role === 'user' && JSON.stringify(x.content).includes('[plain] 子任务')))
  ok(childReq && !childReq.tools.some((t) => t.function.name === 'navo_send_message'), 'delegated conversation cannot delegate further (max depth 1)')

  await api('skills.save', 'doomed', '---\nname: doomed\ndescription: to be deleted\n---\n')
  const t3 = await api('threads.create', m.id)
  const evs = await run(t3.id, '[navo-delete] 删掉 doomed')
  ok(
    evs.some((e) => e.type === 'interrupt' && e.interrupt.actionRequests[0].name === 'navo_delete_skill'),
    'destructive navo tools require approval',
  )
  ok(
    (await api('skills.list')).some((s) => s.name === 'doomed'),
    'nothing deleted before approval',
  )
  const from = (await page.evaluate(() => window.__events)).length
  await api('chat.resume', t3.id, [{ type: 'approve' }])
  for (let i = 0; i < 60; i++) {
    if ((await page.evaluate(() => window.__events)).slice(from).some((e) => e.type === 'run_end')) break
    await new Promise((r) => setTimeout(r, 250))
  }
  ok(!(await api('skills.list')).some((s) => s.name === 'doomed'), 'approved deletion goes through')

  const sp = (await api('threads.state', t1.id)).messages
  ok(
    sp.some((x) => x.role === 'tool' && x.toolName === 'navo_list_models'),
    'tool call recorded in the conversation',
  )
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
