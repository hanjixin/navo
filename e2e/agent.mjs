// Runs one real agent conversation. Requires ANTHROPIC_API_KEY (or OPENAI_API_KEY with PROVIDER=openai-responses|openai).
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const type = process.env.PROVIDER ?? 'anthropic'
const key = type === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY
const model = process.env.MODEL ?? (type === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-5-mini')
if (!key) throw new Error('missing API key')

const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])

await page.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})

const provider = await api('providers.save', { type, name: type, apiKey: key, baseURL: process.env.BASE_URL ?? null })
const m = await api('models.save', { providerId: provider.id, model, displayName: model, supportsTools: true, supportsVision: true })
const test = await api('models.test', m.id)
console.log('model test:', JSON.stringify(test))
await api('settings.set', { devMode: true })

const thread = await api('threads.create', m.id)
await api('chat.send', thread.id, process.env.PROMPT ?? '打开 https://example.com ，告诉我页面的主标题是什么，并把答案写入 /workspace/answer.txt')
const started = Date.now()
while (Date.now() - started < 180000) {
  const evs = await page.evaluate(() => window.__events)
  if (evs.some((e) => e.type === 'run_end' || e.type === 'interrupt')) break
  await page.waitForTimeout(1000)
}
const evs = await page.evaluate(() => window.__events)
const state = await api('threads.state', thread.id)
const summary = state.messages.map(
  (x) =>
    `${x.role}${x.ns ? '[sub]' : ''}: ${x.toolCalls?.length ? 'tools=' + x.toolCalls.map((c) => c.name).join(',') + ' ' : ''}${x.content.slice(0, 160).replace(/\n/g, ' ')}`,
)
console.log(summary.join('\n'))
console.log('event types:', [...new Set(evs.map((e) => e.type))].join(','), 'tokens:', evs.filter((e) => e.type === 'token').length)
console.log(
  'errors:',
  evs.filter((e) => e.type === 'error').map((e) => e.error),
)
console.log('todos:', JSON.stringify(state.todos))
const traces = await api('dev.traces', thread.id)
console.log('traces:', traces.length, 'secs:', Math.round((Date.now() - started) / 1000))
if (process.env.SHOT) {
  await page.evaluate(() => {
    location.hash = '#/chat'
  })
  await page.waitForTimeout(500)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(process.env.SHOT, Buffer.from(png, 'base64'))
}
console.log('userData:', userData)
await app.close()
