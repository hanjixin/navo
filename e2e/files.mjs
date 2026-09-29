// File upload + parsing inside the app: parser process, dedupe, chat attachments, /uploads/ reading,
// failures, and the optional engines (MarkItDown via a fake CLI, MinerU via a fake cloud API).
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ab-files-'))
const bin = join(dir, 'bin')
mkdirSync(bin)
// fake MarkItDown CLI: proves the adapter calls it with the file and uses its stdout
writeFileSync(join(bin, 'markitdown'), '#!/bin/sh\necho "# 来自 MarkItDown"\necho ""\necho "文件：$(basename "$1")"\n')
chmodSync(join(bin, 'markitdown'), 0o755)

// fake MinerU cloud API
const mineruCalls = []
const mineru = createServer(async (req, res) => {
  let body = Buffer.alloc(0)
  for await (const c of req) body = Buffer.concat([body, c])
  mineruCalls.push(`${req.method} ${req.url.split('?')[0]}`)
  const json = (o) => (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)))
  if (req.url === '/api/v4/file-urls/batch') {
    if (req.headers.authorization !== 'Bearer mineru-token') return json({ code: 401, msg: 'token invalid' })
    return json({ code: 0, data: { batch_id: 'b1', file_urls: ['http://127.0.0.1:38983/upload/b1'] } })
  }
  if (req.url === '/upload/b1') return res.writeHead(200).end()
  if (req.url === '/api/v4/extract-results/batch/b1')
    return json({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'http://127.0.0.1:38983/zip/b1' }] } })
  if (req.url === '/zip/b1') {
    const zip = new JSZip()
    zip.file('full.md', '# MinerU 结果\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n')
    res.writeHead(200)
    return res.end(await zip.generateAsync({ type: 'nodebuffer' }))
  }
  res.writeHead(404).end()
}).listen(38983)

// fixtures
const docx = join(dir, '周报.docx')
writeFileSync(
  docx,
  await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '项目周报', heading: HeadingLevel.HEADING_1 }),
            new Paragraph('本周完成登录与支付模块。'),
            new Table({
              rows: [
                ['任务', '状态'],
                ['登录', '完成'],
              ].map((r) => new TableRow({ children: r.map((t) => new TableCell({ children: [new Paragraph(t)] })) })),
            }),
          ],
        },
      ],
    }),
  ),
)
const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(
  book,
  XLSX.utils.aoa_to_sheet([
    ['城市', '人口（万）'],
    ['上海', 2487],
    ['深圳', 1779],
  ]),
  '城市',
)
const xlsx = join(dir, '城市.xlsx')
writeFileSync(xlsx, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
const big = join(dir, '长文档.md')
writeFileSync(
  big,
  `# 长文档\n\n${Array.from({ length: 1200 }, (_, i) => `第 ${i + 1} 段：这是一段用于测试长文档读取的内容，内容会重复很多次以超过内联预算。`).join('\n\n')}\n\n尾声标记-Z9K2\n`,
)
// a large screenshot-like PNG and a scanned PDF (image only, no text layer)
const shot = createCanvas(3200, 1400)
{
  const g = shot.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, 3200, 1400)
  g.fillStyle = '#000'
  g.font = '120px sans-serif'
  g.fillText('NAVO VISION 42', 200, 700)
}
const shotPng = shot.toBuffer('image/png')
const imgPath = join(dir, '截图.png')
writeFileSync(imgPath, shotPng)
const scanPath = join(dir, '扫描件.pdf')
{
  const doc = await PDFDocument.create()
  const png = await doc.embedPng(shotPng)
  doc.addPage([842, 368]).drawImage(png, { x: 0, y: 0, width: 842, height: 368 })
  writeFileSync(scanPath, await doc.save())
}
const broken = join(dir, '损坏.pdf')
writeFileSync(broken, '%PDF-1.7\nthis is not really a pdf')

const mock = startMock(38982)
const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), 'ab-home-')),
    AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-profile-')),
    AB_EXTRA_PATH: bin,
    AB_MINERU_BASE: 'http://127.0.0.1:38983',
  },
})
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const waitReady = async (id, ms = 60000) => {
  for (let t = 0; t < ms / 250; t++) {
    const f = await api('files.get', id)
    if (f.status === 'ready' || f.status === 'error') return f
    await new Promise((r) => setTimeout(r, 250))
  }
  return api('files.get', id)
}
await page.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})
const runAndWait = async (threadId, text, fileIds) => {
  const from = (await page.evaluate(() => window.__events)).length
  await api('chat.send', threadId, text, [], fileIds)
  for (let i = 0; i < 160; i++) {
    if ((await page.evaluate(() => window.__events)).slice(from).some((e) => e.type === 'run_end' && e.threadId === threadId)) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

try {
  // a real Chromium-printed Chinese PDF, generated inside the app
  const pdfPath = join(dir, '报告.pdf')
  const pdfB64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false })
    await w.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<meta charset=utf-8><body style="font-family:PingFang SC,sans-serif"><h1>季度报告</h1><p>收入同比增长 23%，毛利率 41%。</p><table border=1><tr><th>地区</th><th>收入</th></tr><tr><td>华东</td><td>5200</td></tr><tr><td>华南</td><td>3900</td></tr></table></body>',
        ),
    )
    const b = await w.webContents.printToPDF({})
    w.destroy()
    return b.toString('base64')
  })
  writeFileSync(pdfPath, Buffer.from(pdfB64, 'base64'))

  const added = await api('files.addPaths', [docx, pdfPath, xlsx, broken])
  ok(added.length === 4 && added.every((f) => ['queued', 'parsing'].includes(f.status)), 'files queued for background parsing')
  const [fDocx, fPdf, fXlsx, fBroken] = await Promise.all(added.map((f) => waitReady(f.id)))
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => x.name ?? ''))
  ok(metrics.includes('Navo Parser'), 'parsing runs in its own utility process')
  ok(fDocx.status === 'ready' && (await api('files.markdown', fDocx.id)).includes('# 项目周报'), 'Word parsed with headings')
  const pdfMd = await api('files.markdown', fPdf.id)
  ok(
    fPdf.status === 'ready' && fPdf.units === 1 && pdfMd.includes('收入同比增长 23%，毛利率 41%。') && /\|\s*华南\s*\|\s*3900\s*\|/.test(pdfMd),
    'Chinese PDF parsed (text exact, table rebuilt, cmaps loaded)',
  )
  ok(fXlsx.status === 'ready' && /\|\s*上海\s*\|\s*2487\s*\|/.test(await api('files.markdown', fXlsx.id)), 'Excel parsed to a table')
  ok(fBroken.status === 'error' && fBroken.error?.length > 0, `corrupt file fails with an error (${fBroken.error?.slice(0, 60)})`)

  const again = await api('files.addPaths', [docx])
  ok(again[0].id === fDocx.id, 'identical content is deduplicated')

  // chat: small files inline, UI shows only the user's words + chips
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  const t = await api('threads.create', m.id)
  await runAndWait(t.id, '[plain] 总结这两个文件', [fDocx.id, fXlsx.id])
  const req = mock.requests.find((r) => JSON.stringify(r.messages).includes('总结这两个文件'))
  const sent = JSON.stringify(req.messages)
  ok(
    sent.includes('<file name=\\"周报.docx\\"') && sent.includes('本周完成登录与支付模块。') && sent.includes('上海'),
    'parsed content sent inline to the model',
  )
  const st = await api('threads.state', t.id)
  const userMsg = st.messages.find((x) => x.role === 'user')
  ok(
    userMsg.content === '[plain] 总结这两个文件' && userMsg.attachments?.map((a) => a.name).join() === '周报.docx,城市.xlsx',
    'user bubble keeps the original words and lists attachments',
  )

  // vision: pictures and scanned pages go to the model as images (OCR off here: no network in CI)
  await api('settings.set', { files: { defaultEngine: 'builtin', ocr: false } })
  const [fImg, fScan] = await api('files.addPaths', [imgPath, scanPath])
  const [rImg, rScan] = [await waitReady(fImg.id), await waitReady(fScan.id)]
  ok(rImg.status === 'ready' && rScan.status === 'ready', `image + scanned PDF parsed (${rImg.error ?? ''}${rScan.error ?? ''} ${rScan.warnings.join(';')})`)
  ok(
    (await api('files.thumbnail', fImg.id))?.startsWith('data:image/jpeg;base64,') && (await api('files.thumbnail', fScan.id))?.startsWith('data:image/jpeg'),
    'thumbnails for image and scanned PDF',
  )
  const vm = await api('models.save', { providerId: p.id, model: 'mock-vision', displayName: 'Mock Vision', supportsTools: true, supportsVision: true })
  const tv = await api('threads.create', vm.id)
  await runAndWait(tv.id, '[plain] 看看这张图和扫描件', [fImg.id, fScan.id])
  const findReq = (text) => mock.requests.filter((r) => JSON.stringify(r.messages).includes(text)).at(-1)
  const userOf = (r) => r.messages.filter((x) => x.role === 'user').at(-1)
  const urls = (r) => (Array.isArray(userOf(r).content) ? userOf(r).content : []).filter((b) => b.type === 'image_url').map((b) => b.image_url.url)
  const vReq = findReq('看看这张图和扫描件')
  const sentImgs = urls(vReq)
  ok(
    sentImgs.length === 2 && sentImgs.every((u) => u.startsWith('data:image/jpeg;base64,')),
    `vision model receives the picture and the scanned page as images (${sentImgs.length})`,
  )
  const dims = await Promise.all(sentImgs.map(async (u) => loadImage(Buffer.from(u.split(',')[1], 'base64'))))
  ok(
    dims.every((d) => Math.max(d.width, d.height) <= 2000) && dims[0].width >= 1900,
    `large images are downscaled to ≤2000px (${dims.map((d) => `${d.width}x${d.height}`).join(', ')})`,
  )
  const vText = JSON.stringify(userOf(vReq).content)
  ok(vText.includes('images=\\"') && vText.includes('请直接看图'), 'context tells the model which image belongs to which file')
  const vState = await api('threads.state', tv.id)
  const vUser = vState.messages.find((x) => x.role === 'user')
  ok(!vUser.images?.length && vUser.attachments?.length === 2, 'attachment images are not duplicated in the user bubble')

  const tn = await api('threads.create', m.id)
  await runAndWait(tn.id, '[plain] 不支持看图的模型', [fImg.id])
  ok(urls(findReq('不支持看图的模型')).length === 0, 'non-vision model gets no image blocks')

  // real OCR of a scanned page inside the parser process, with the bundled language data (offline)
  {
    await api('settings.set', { files: { defaultEngine: 'builtin', ocr: true } })
    await api('files.reparse', fScan.id)
    const o = await waitReady(fScan.id, 180000)
    const text = o.status === 'ready' ? await api('files.markdown', fScan.id) : o.error
    ok(/NAVO\s*VISION\s*42/i.test(text) && o.ocrPages?.includes(1), `scanned PDF page OCR'd in the parser process (${text.replace(/\s+/g, ' ').slice(0, 80)})`)
  }

  // regenerate keeps the attachments (text and images)
  const before = mock.requests.length
  await page.evaluate(() => (window.__events = []))
  await api('chat.regenerate', tv.id, vUser.id)
  for (let i = 0; i < 160 && !(await page.evaluate(() => window.__events.some((e) => e.type === 'run_end'))); i++) await new Promise((r) => setTimeout(r, 250))
  const regen = mock.requests.slice(before).find((r) => JSON.stringify(r.messages).includes('看看这张图和扫描件'))
  ok(regen && urls(regen).length === 2 && JSON.stringify(regen.messages).includes('截图.png'), 'regenerate re-sends the attached files')

  // large file: preview + path; the agent reads the rest from /uploads/
  const [fBig] = await api('files.addPaths', [big])
  await waitReady(fBig.id)
  const t2 = await api('threads.create', m.id)
  await runAndWait(t2.id, '[readupload] 长文档最后写了什么', [fBig.id])
  const req2 = JSON.stringify(mock.requests.find((r) => JSON.stringify(r.messages).includes('长文档最后写了什么')).messages)
  ok(req2.includes('truncated=\\"true\\"') && !req2.includes('尾声标记-Z9K2'), 'large file is previewed, not sent whole')
  const st2 = await api('threads.state', t2.id)
  ok(st2.messages.at(-1)?.content.includes('尾声标记-Z9K2'), 'agent reads the full document from /uploads/ with read_file')

  // optional engines
  const engines = await api('files.engines')
  ok(
    engines.find((e) => e.id === 'markitdown')?.available && !engines.find((e) => e.id === 'mineru')?.available,
    'engine availability detected (markitdown on PATH, MinerU needs a token)',
  )
  await api('files.reparse', fDocx.id, 'markitdown')
  const viaMd = await waitReady(fDocx.id)
  ok(viaMd.engine === 'markitdown' && (await api('files.markdown', fDocx.id)).includes('来自 MarkItDown'), 're-parse with MarkItDown uses its output')

  await api('settings.set', { mineruToken: 'mineru-token' })
  ok((await api('files.engines')).find((e) => e.id === 'mineru')?.available, 'MinerU available once a token is saved')
  await api('files.reparse', fPdf.id, 'mineru')
  const viaMu = await waitReady(fPdf.id, 30000)
  ok(
    viaMu.engine === 'mineru' && (await api('files.markdown', fPdf.id)).includes('MinerU 结果'),
    `MinerU flow: request URL → upload → poll → zip (${mineruCalls.join(', ')})`,
  )

  await api('files.delete', fXlsx.id)
  ok(!(await api('files.list')).some((f) => f.id === fXlsx.id), 'delete removes the file')
} catch (e) {
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  mineru.close()
}
