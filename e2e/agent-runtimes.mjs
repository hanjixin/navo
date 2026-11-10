// Real UI + isolated SQLite + an owned fake CLI. Never uses a vendor account or model.
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-agent-runtimes-'))
const cli = join(profile, 'fake-claude.cjs')
const transcript = join(profile, 'fake-cli.jsonl')
appendFileSync(transcript, '')
writeFileSync(
  cli,
  `
const fs = require('node:fs')
const log = (value) => fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(value) + '\\n')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (args.includes('--version')) { log({ probe: true }); console.log('Navo fixture Claude 1.0'); process.exit(0) }
if (value('--tools') !== '' || value('--permission-mode') !== 'dontAsk') { process.exit(4) }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line)
  if (input.type === 'control_request' && input.request.subtype === 'initialize') { send({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: {} } }); return }
  if (input.type !== 'user') return
  const text = input.message.content
  const model = value('--model')
  const resume = args.includes('--resume') ? value('--resume') : null
  const session = resume || 'fixture-session-' + Date.now()
  log({ model, resume, session, text, cwd: process.cwd() })
  send({ type: 'system', subtype: 'init', session_id: session })
  send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } })
  const answer = text.includes('wait-for-stop') ? 'Started waiting' : 'fixture:' + model + ':' + (resume ? 'resumed' : 'new') + ':' + text
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } })
  if (text.includes('wait-for-stop')) return
  setTimeout(() => {
    send({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: answer }] } })
    send({ type: 'result', subtype: 'success', result: answer, session_id: session, usage: { input_tokens: 12, output_tokens: 7 } })
  }, 150)
})
`,
)

let app, page
const launch = async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  page = await mainWindow(app)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
    }
  })
  await page.evaluate(() => {
    window.__runtimeEvents = []
    window.api.on('chat.event', (event) => window.__runtimeEvents.push(event))
  })
}
const api = (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
const route = (path) =>
  page.evaluate((path) => {
    window.location.hash = path
  }, path)
const input = () => page.locator('main textarea').last()
const logs = () =>
  readFileSync(transcript, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const editor = () => page.getByTestId('runtime-claude')
const openEditor = async () => {
  await route('/settings')
  await expect(editor()).toBeVisible()
  if (!(await editor().evaluate((element) => element.open))) await editor().locator('summary').click()
}
const saveEditor = async () => {
  await editor().getByRole('button', { name: '保存', exact: true }).click()
  // Saved configuration replaces this card to discard the local draft.
  await expect.poll(() => editor().evaluate((element) => element.open)).toBe(false)
  await editor().locator('summary').click()
  await expect(editor().getByRole('button', { name: '保存', exact: true })).toBeDisabled()
}
const chooseClaude = async () => {
  await page.getByTestId('composer-runtime').getByRole('combobox').click()
  await page.getByRole('option', { name: 'Claude Code', exact: true }).click()
}
const send = async (text) => {
  await expect(input()).toBeEnabled()
  await input().fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
const finished = async (id, expected) => {
  await expect
    .poll(async () => (await api('threads.state', id)).messages.some((message) => message.role === 'assistant' && message.content === expected))
    .toBe(true)
  await expect.poll(async () => (await api('threads.state', id)).running).toBe(false)
}

try {
  await launch()
  assert.equal((await api('models.list')).length, 0, 'external runtime must work without a Navo model')
  await openEditor()
  await editor().getByLabel('可执行文件或命令', { exact: true }).fill(process.execPath)
  await editor()
    .getByLabel(/启动参数（JSON 数组）/)
    .fill('invalid')
  await editor().getByLabel('运行时模型', { exact: true }).fill('fixture-v1')
  await editor().getByRole('switch').check()
  await editor().getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor().getByRole('alert')).toHaveText('启动参数必须是 JSON 字符串数组')
  await editor()
    .getByLabel(/启动参数（JSON 数组）/)
    .fill(JSON.stringify([cli]))
  await expect(editor().getByRole('button', { name: '检测命令', exact: true })).toBeDisabled()
  await saveEditor()
  await editor().getByRole('button', { name: '检测命令', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText('Navo fixture Claude 1.0')
  assert.equal(logs().filter((entry) => !entry.probe).length, 0, 'version probe must not start a model run')

  await route('/chat')
  await chooseClaude()
  await send('first-runtime-turn')
  await expect.poll(() => page.url()).toMatch(/\/chat\/[a-z0-9-]+$/)
  const first = (await api('threads.list')).find((thread) => thread.runtimeId === 'claude')
  assert.ok(first)
  await finished(first.id, 'fixture:fixture-v1:new:first-runtime-turn')
  assert.ok(await page.evaluate(() => window.__runtimeEvents.some((event) => event.type === 'token' && event.text.includes('first-runtime-turn'))))

  // Configuration changes only affect new conversations.
  await openEditor()
  await editor().getByLabel('运行时模型', { exact: true }).fill('fixture-v2')
  await saveEditor()
  await route(`/chat/${first.id}`)
  await send('snapshot-turn')
  await finished(first.id, 'fixture:fixture-v1:resumed:snapshot-turn')

  await app.close()
  await launch()
  await route(`/chat/${first.id}`)
  await expect(page.locator('main')).toContainText('fixture:fixture-v1:new:first-runtime-turn')
  await send('after-restart')
  await finished(first.id, 'fixture:fixture-v1:resumed:after-restart')
  const firstSession = logs().find((entry) => entry.text === 'first-runtime-turn').session
  assert.equal(logs().find((entry) => entry.text === 'after-restart').resume, firstSession)

  await route('/chat')
  await chooseClaude()
  await send('new-config-turn')
  await expect.poll(async () => (await api('threads.list')).filter((thread) => thread.runtimeId === 'claude').length).toBe(2)
  const second = (await api('threads.list')).find((thread) => thread.runtimeId === 'claude' && thread.id !== first.id)
  await finished(second.id, 'fixture:fixture-v2:new:new-config-turn')

  await send('wait-for-stop')
  await expect(page.locator('main')).toContainText('Started waiting')
  await page.locator('main').getByRole('button', { name: '停止', exact: true }).last().click()
  await expect.poll(async () => (await api('threads.state', second.id)).running).toBe(false)
  await send('after-stop')
  await finished(second.id, 'fixture:fixture-v2:resumed:after-stop')

  await openEditor()
  await editor().getByRole('switch').uncheck()
  await saveEditor()
  await route(`/chat/${first.id}`)
  await expect(page.locator('main')).toContainText('fixture:fixture-v1:new:first-runtime-turn')
  await input().fill('disabled-runtime')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  const count = logs().length
  await assert.rejects(api('chat.submit', { requestId: 'disabled-runtime-fixture', threadId: first.id, text: 'blocked' }), /disabled/i)
  assert.equal(logs().length, count, 'disabled runtime must not launch a child')
  console.log('PASS runtime settings, version-only probe, model-free chat, streaming, restart/resume, configuration snapshots, abort and disabled history')
} catch (error) {
  console.error(`FAIL agent-runtimes (${profile})`, error)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
}
