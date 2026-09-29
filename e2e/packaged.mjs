// Smoke test of the packaged app (pnpm dist first): native modules, asar-bundled agent process and tools.
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMock } from './mock-llm.mjs'

const exe =
  process.argv[2] ??
  (process.platform === 'darwin' ? ['release/mac-arm64/Navo.app/Contents/MacOS/Navo', 'release/mac/Navo.app/Contents/MacOS/Navo'].find(existsSync) : undefined)
if (!exe) throw new Error('packaged app not found; run `pnpm dist` or pass the executable path')

const mock = startMock(38989)
const app = await electron.launch({ executablePath: exe, env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-pkg-')) } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
try {
  ok(await app.evaluate(({ app }) => app.isPackaged), 'running the packaged build')
  const p = await api('providers.save', { type: 'openai-compatible', name: 'mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  ok(!!m.id, 'SQLite (native better-sqlite3) works')
  await page.evaluate(() => {
    window.__events = []
    window.api.on('chat.event', (e) => window.__events.push(e))
  })
  const t = await api('threads.create', m.id)
  await api('chat.send', t.id, '打开页面并保存')
  for (let i = 0; i < 80; i++) {
    if ((await page.evaluate(() => window.__events)).some((e) => e.type === 'run_end')) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const st = await api('threads.state', t.id)
  ok(
    st.messages.some((x) => x.role === 'tool' && x.toolName === 'browser_navigate' && x.content.includes('Hello Agent')),
    'agent process (from asar) drives the browser',
  )
  ok(st.messages.at(-1)?.content.includes('Hello Agent'), 'run completes with a final answer')

  // file parsing: parser process from asar, pdf.js + cmaps from resources, native canvas unpacked
  const dir = mkdtempSync(join(tmpdir(), 'ab-pkg-files-'))
  const pdfB64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false })
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta charset=utf-8><h1>打包测试</h1><p>中文段落解析正常。</p>'))
    const b = await w.webContents.printToPDF({})
    w.destroy()
    return b.toString('base64')
  })
  writeFileSync(join(dir, 'a.pdf'), Buffer.from(pdfB64, 'base64'))
  const c = createCanvas(600, 200)
  c.getContext('2d').fillRect(0, 0, 300, 100)
  const png = c.toBuffer('image/png')
  writeFileSync(join(dir, 'b.png'), png)
  const doc = await PDFDocument.create()
  doc.addPage([600, 200]).drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 600, height: 200 })
  writeFileSync(join(dir, 'c.pdf'), await doc.save())
  await api('settings.set', { files: { defaultEngine: 'builtin', ocr: false } })
  const added = await api(
    'files.addPaths',
    ['a.pdf', 'b.png', 'c.pdf'].map((f) => join(dir, f)),
  )
  const done = []
  for (const f of added) {
    let r = f
    for (let i = 0; i < 240 && !['ready', 'error'].includes(r.status); i++) {
      await new Promise((res) => setTimeout(res, 250))
      r = await api('files.get', f.id)
    }
    done.push(r)
  }
  ok(
    done[0].status === 'ready' && (await api('files.markdown', done[0].id)).includes('中文段落解析正常。'),
    `PDF parsed in the packaged app (${done[0].error ?? 'ok'})`,
  )
  ok((await api('files.thumbnail', done[1].id))?.startsWith('data:image/jpeg'), 'image visual written with native canvas')
  ok((await api('files.thumbnail', done[2].id))?.startsWith('data:image/jpeg'), 'scanned PDF page rendered in the parser process')
  // OCR with the language data shipped in Resources/tessdata (fresh profile: nothing cached)
  const t2 = mkdtempSync(join(tmpdir(), 'ab-pkg-ocr-'))
  const tc = createCanvas(1200, 300)
  const g = tc.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, 1200, 300)
  g.fillStyle = '#000'
  g.font = '80px sans-serif'
  g.fillText('PACKAGED OCR 7', 60, 180)
  writeFileSync(join(t2, 'ocr.png'), tc.toBuffer('image/png'))
  await api('settings.set', { files: { defaultEngine: 'builtin', ocr: true } })
  let o = (await api('files.addPaths', [join(t2, 'ocr.png')]))[0]
  for (let i = 0; i < 480 && !['ready', 'error'].includes(o.status); i++) {
    await new Promise((res) => setTimeout(res, 250))
    o = await api('files.get', o.id)
  }
  const ocrMd = o.status === 'ready' ? await api('files.markdown', o.id) : o.error
  // synthetic canvas text: allow one misread letter, the point is that recognition runs offline
  ok(/PACK\w{2,5}\s*OCR\s*7/.test(ocrMd), `OCR works offline with bundled language data (${ocrMd.replace(/\s+/g, ' ').slice(0, 60)})`)
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
