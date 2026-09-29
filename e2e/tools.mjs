// Exercises browser tools, recorder and macro playback without calling any LLM.
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) process.exitCode = 1
}

const FORM =
  'data:text/html,' +
  encodeURIComponent(`<!doctype html><title>Form Test</title>
<h1>Signup</h1><label for=n>Name</label><input id=n name=username>
<select id=c><option>Red</option><option>Blue</option></select>
<button id=go onclick="document.getElementById('out').textContent='Hello '+document.getElementById('n').value+' '+document.getElementById('c').value">Submit</button>
<p id=out></p>`)

try {
  const nav = await api('dev.invokeTool', 'browser_navigate', { url: FORM })
  ok(nav.includes('Form Test') && /\[e\d+\] textbox "Name"/.test(nav), 'navigate + snapshot lists labelled textbox')
  const ref = (label) => new RegExp(`\\[(e\\d+)\\] ${label}`).exec(nav)?.[1]
  await api('dev.invokeTool', 'browser_type', { ref: ref('textbox "Name"'), text: 'Ada' })
  await api('dev.invokeTool', 'browser_select', { ref: ref('combobox'), value: 'Blue' })
  const after = await api('dev.invokeTool', 'browser_click', { ref: ref('button "Submit"') })
  ok(after.includes('Hello Ada Blue'), 'type + select + click via CDP input')
  const extract = await api('dev.invokeTool', 'browser_extract', {})
  ok(extract.includes('Hello Ada Blue'), 'extract text')
  const shot = await api('dev.invokeTool', 'browser_screenshot', {})
  ok(Array.isArray(shot) && shot[1]?.image_url?.url?.startsWith('data:image/jpeg'), 'screenshot returns image block')

  // recorder: record real user-like input events dispatched through CDP
  await api('browser.navigate', FORM)
  await page.waitForTimeout(800)
  await api('macros.startRecording')
  await page.waitForTimeout(300)
  const snap = await api('dev.invokeTool', 'browser_snapshot', {})
  const r2 = (label) => new RegExp(`\\[(e\\d+)\\] ${label}`).exec(snap)?.[1]
  await api('dev.invokeTool', 'browser_type', { ref: r2('textbox "Name"'), text: 'Grace' })
  await api('dev.invokeTool', 'browser_select', { ref: r2('combobox'), value: 'Blue' })
  await api('dev.invokeTool', 'browser_click', { ref: r2('button "Submit"') })
  await page.waitForTimeout(500)
  const macro = await api('macros.stopRecording')
  ok(
    macro && macro.steps.length >= 3,
    `recorder captured ${macro?.steps.length} steps: ${macro?.steps.map((s) => s.type + ':' + (s.selectors?.[0] ?? s.url)).join(' | ')}`,
  )

  // parameterize and replay
  const typeStep = macro.steps.find((s) => s.type === 'type')
  typeStep.value = '{{name}}'
  const saved = await api('macros.save', { ...macro, startUrl: FORM, exposeAsTool: true, name: 'signup' })
  ok(
    saved.params.some((p) => p.name === 'name'),
    'placeholder becomes a macro param',
  )
  const run = await api('macros.run', saved.id, { name: 'Linus' })
  const text = await api('dev.invokeTool', 'browser_extract', {})
  ok(run.ok && text.includes('Hello Linus Blue'), `macro replay with params (${run.error ?? 'ok'})`)
  const tools = await api('dev.tools')
  ok(
    tools.some((t) => t.name === 'macro_signup'),
    'macro exposed as agent tool',
  )

  // site plugin on a matching page (Hacker News)
  const hn = await api('dev.invokeTool', 'browser_navigate', { url: 'https://news.ycombinator.com/' }).catch((e) => String(e))
  if (/Hacker News/.test(hn)) {
    const stories = await api('plugins.runAction', 'hacker-news', 'list_stories', { limit: 3 })
    ok(Array.isArray(stories) && stories.length === 3 && stories[0].title, 'plugin action runs in isolated world')
    const t2 = await api('dev.tools')
    ok(
      t2.some((t) => t.name === 'plugin_hacker_news_list_stories'),
      'plugin actions become tools on matching page',
    )
  } else console.log('SKIP plugin test (network):', hn.slice(0, 120))
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
}
