// Opt-in live runtime test. Uses the installed CLI's own auth, an isolated Navo profile,
// synthetic memory, a loopback page and a harmless file. Never copies credentials.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { mainWindow } from '../e2e/helpers.mjs'

const engine = process.argv[2]
const command = process.argv[3]
if (!['claude', 'codex'].includes(engine) || !command) throw new Error('Usage: node scripts/runtime-live-smoke.mjs claude|codex /absolute/cli/path')
const profile = mkdtempSync(join(tmpdir(), `navo-live-${engine}-`))
const pageMarker = `PAGE-${randomUUID().slice(0, 8)}`
const memoryMarker = `NOTE-${randomUUID().slice(0, 8)}`
const site = createServer((_req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<title>Runtime test</title><h1>${pageMarker}</h1>`),
)
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${site.address().port}/`
let app, threadId
const report = { engine, profile, passed: false, rounds: [], errors: [] }
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000', ELECTRON_RENDERER_URL: '' } })
  const page = await mainWindow(app)
  const api = (name, ...args) => page.evaluate(([name, args]) => window.api.invoke(name, ...args), [name, args])
  await page.evaluate(() => {
    window.__liveRuntimeEvents = []
    window.api.on('chat.event', (event) => window.__liveRuntimeEvents.push(event))
  })
  await api('settings.set', { approvalTools: ['write_file'] })
  await api('memory.save', { kind: 'knowledge', title: 'bridge-live-fixture', content: memoryMarker })
  const runtime = (await api('runtimes.list')).find((item) => item.profile.id === engine)
  await api('runtimes.save', { ...runtime.profile, enabled: true, command, args: [] })
  const project = await api('projects.save', { name: `${engine} MCP 实测`, description: '仅测试本地页面、合成记忆和生成文件' })
  const wait = async (id, round) => {
    const deadline = Date.now() + 150_000
    const approved = new Set()
    while (Date.now() < deadline) {
      const state = await api('threads.state', id)
      const events = await page.evaluate((id) => window.__liveRuntimeEvents.filter((event) => event.threadId === id), id)
      const error = events.find((event) => event.type === 'error')
      if (error) throw new Error(error.error)
      if (state.interrupt && !approved.has(state.interrupt.id)) {
        assert.ok(
          state.interrupt.actionRequests.every((tool) => tool.name === 'write_file' && tool.args.file_path === `/workspace/${engine}-tool-test.txt`),
          'Unexpected tool approval',
        )
        approved.add(state.interrupt.id)
        await api(
          'chat.resume',
          id,
          state.interrupt.actionRequests.map(() => ({ type: 'approve' })),
          [],
          state.interrupt.id,
        )
      }
      if (!state.running && !state.interrupt && events.some((event) => event.type === 'run_end')) {
        const assistants = state.messages.filter((message) => message.role === 'assistant')
        assert.ok(!assistants.some((message) => message.runtimeWarning === 'unexecuted_tool_markup'), 'Tool markup was returned without execution')
        report.rounds.push({
          round,
          streamed: events.some((event) => event.type === 'token'),
          approved: approved.size,
          final: assistants.at(-1)?.content,
          calls: state.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.name),
        })
        return state
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await api('chat.stop', id)
    throw new Error('Live runtime timed out after 150 seconds')
  }
  const first = await api('chat.submit', {
    requestId: randomUUID(),
    runtimeId: engine,
    projectId: project.id,
    text: `这是 Navo 工具桥真实验收。请只使用 Navo MCP 工具：先用 memory_search 查找 bridge-live-fixture 记录里的 NOTE 标记，再用 browser_navigate 打开 ${url} 读取页面 h1 的 PAGE 标记。最后用 write_file 将这两个标记写到 /workspace/${engine}-tool-test.txt（每行一个）。写文件需要批准时等待即可。不要调用 Bash、系统浏览器、其他外部服务；不要假装执行。完成后用一行中文报告两个标记。`,
  })
  threadId = first.threadId
  console.log(`START ${engine} ${threadId}`)
  const state = await wait(threadId, 1)
  const toolNames = state.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.name)
  for (const tool of ['memory_search', 'browser_navigate', 'write_file']) assert.ok(toolNames.includes(tool), `Missing Navo tool: ${tool}`)
  const file = readFileSync(join(profile, 'workspace', `${engine}-tool-test.txt`), 'utf8')
  assert.ok(file.includes(pageMarker) && file.includes(memoryMarker), 'Output markers mismatch')
  const artifacts = await api('artifacts.query', { threadId })
  assert.ok(
    artifacts.items.some((artifact) => artifact.name === `${engine}-tool-test.txt`),
    'Artifact missing',
  )
  await page.evaluate(() => {
    window.__liveRuntimeEvents = []
  })
  await api('chat.submit', { requestId: randomUUID(), threadId, text: '不调用工具，只复述上一轮从页面和记忆读到的两个标记，用于验证本会话续接。' })
  await wait(threadId, 2)
  assert.ok(report.rounds[1].final.includes(pageMarker) && report.rounds[1].final.includes(memoryMarker), 'Session resume lost context')
  report.passed = true
  console.log(`PASS ${engine}: real Navo memory/browser/file/approval/artifact and session resume`)
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL ${engine}: ${report.errors.at(-1)}`)
  process.exitCode = 1
} finally {
  writeFileSync(join(profile, 'live-report.json'), JSON.stringify(report, null, 2))
  console.log(`REPORT ${join(profile, 'live-report.json')}`)
  await app?.close().catch(() => undefined)
  site.close()
}
