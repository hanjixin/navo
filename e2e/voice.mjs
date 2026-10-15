// Voice input with Chromium's fake microphone: hold to talk, tap to start / stop, Esc to cancel,
// auto-send; the recording reaches the provider's /audio/transcriptions as 16 kHz WAV.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const mock = startMock(38987)
const app = await electron.launch({
  args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')), AB_MEMORY_IDLE_MS: '600000' },
})
const win = await mainWindow(app)
const api = (m, ...a) => win.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15000) => {
  for (let i = 0; i < ms / 200; i++) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(200)
  }
  return null
}
const SAID = '帮我查一下明天北京的天气'
const textarea = () => win.locator('textarea').first()
const mic = () => win.getByRole('button', { name: /语音输入|完成录音/ }).first()
const hold = async (ms) => {
  const box = await mic().boundingBox()
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await sleep(ms)
  await win.mouse.up()
}

try {
  // an Anthropic model only: chat works, but Anthropic has no speech-to-text
  const a = await api('providers.save', { type: 'anthropic', name: 'Claude', baseURL: 'http://127.0.0.1:9', apiKey: 'x' })
  await api('models.save', { providerId: a.id, model: 'claude-x', displayName: 'Claude', supportsTools: true, supportsVision: false, isDefault: true })
  await win.reload()
  await mainWindow(app)
  await win.evaluate(() => (window.location.hash = '#/chat'))
  await win.waitForSelector('textarea:not([disabled])', { timeout: 8000 })
  await hold(300)
  ok(!!(await win.waitForSelector('text=无法开始语音输入', { timeout: 5000 }).catch(() => null)), 'without a speech service it says what to set up')

  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })
  const s = await api('settings.get')
  await api('settings.set', { voice: { ...s.voice, language: 'zh' } })
  const st = await api('voice.status')
  ok(st.ready && st.label === 'Mock · whisper-1', `ready with the first OpenAI-compatible provider (${st.label})`)

  // ---------- hold to talk
  const box = await mic().boundingBox()
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  const bar = await win.waitForSelector('[data-testid=voice-bar]', { timeout: 5000 }).catch(() => null)
  ok(!!bar && (await bar.textContent()).includes('正在听'), 'holding the mic records (with a level meter and timer)')
  await sleep(1600)
  await win.screenshot({ path: join(out, 'voice-recording.png') })
  await win.mouse.up()
  await until(async () => (await textarea().inputValue()) === SAID)
  ok((await textarea().inputValue()) === SAID, 'releasing it puts the text in the box (not sent)')
  const t1 = mock.transcriptions[0]
  ok(
    t1?.model === 'whisper-1' && t1.language === 'zh' && t1.wav && t1.bytes > 40000 && t1.prompt?.includes('简体中文'),
    `the provider got a WAV (${t1?.bytes} bytes), the model, the language and a Chinese punctuation hint`,
  )

  // ---------- tap to start, tap to stop: appended
  await mic().click()
  await win.waitForSelector('[data-testid=voice-bar]', { timeout: 5000 })
  await sleep(1000)
  ok((await win.$('[data-testid=voice-bar]')) !== null, 'a tap keeps recording until the next tap')
  await mic().click()
  await until(async () => (await textarea().inputValue()) === `${SAID} ${SAID}`)
  ok((await textarea().inputValue()) === `${SAID} ${SAID}`, 'the next tap stops; the text is appended')

  // ---------- Esc cancels
  const n = mock.transcriptions.length
  await textarea().fill('')
  await mic().click()
  await win.waitForSelector('[data-testid=voice-bar]', { timeout: 5000 })
  await sleep(600)
  await win.keyboard.press('Escape')
  await sleep(800)
  ok(
    mock.transcriptions.length === n && (await win.$('[data-testid=voice-bar]')) === null && (await textarea().inputValue()) === '',
    'Esc cancels without transcribing',
  )

  // ---------- ⌘⇧M and auto-send
  await api('settings.set', { voice: { ...(await api('settings.get')).voice, autoSend: true } })
  await win.waitForTimeout(300)
  await win.keyboard.press('Meta+Shift+M')
  await win.waitForSelector('[data-testid=voice-bar]', { timeout: 5000 })
  await sleep(1000)
  await win.keyboard.press('Meta+Shift+M')
  const sent = await until(async () => mock.requests.find((r) => JSON.stringify(r.messages).includes(SAID)))
  ok(!!sent, '⌘⇧M starts and stops; with auto-send the message goes out')

  // ---------- settings
  await win.evaluate(() => (window.location.hash = '#/settings'))
  await win.waitForSelector('[data-testid=voice-settings]', { timeout: 5000 })
  ok((await win.textContent('[data-testid=voice-settings]')).includes('当前：Mock · whisper-1'), 'settings show the engine in use')
  await win.getByRole('button', { name: 'gpt-4o-mini-transcribe' }).click()
  ok(await until(async () => (await api('settings.get')).voice.model === 'gpt-4o-mini-transcribe'), 'a suggested model is one click')
  await win.locator('[data-testid=voice-settings]').scrollIntoViewIfNeeded()
  await sleep(300)
  await win.screenshot({ path: join(out, 'voice-settings.png') })
} catch (e) {
  await win.screenshot({ path: join(out, 'voice-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
