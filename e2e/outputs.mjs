// Outputs: files the agent wrote under /workspace/ and files downloaded in its tab are listed per
// conversation, previewed, and exported to Word / PDF / Excel (also by the agent's export_file).
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const profile = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const downloads = mkdtempSync(join(tmpdir(), 'ab-downloads-'))
const exportsDir = mkdtempSync(join(tmpdir(), 'ab-exports-'))
const site = createServer((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="orders.csv"' }).end('单号,金额\nA-1,100\n'),
).listen(38994)

const mock = startMock(38995)
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
const win = await mainWindow(app)
const api = (m, ...a) => win.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 20000) => {
  for (let i = 0; i < ms / 200; i++) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(200)
  }
  return null
}
await win.evaluate(() => {
  window.__events = []
  window.api.on('chat.event', (e) => window.__events.push(e))
})
const runAndWait = async (threadId, text) => {
  await win.evaluate(() => window.__events.splice(0))
  await api('chat.send', threadId, text)
  return until(async () => (await win.evaluate(() => window.__events)).find((e) => e.type === 'run_end' && e.threadId === threadId), 60000)
}
// downloads go to a temp folder, not the real ~/Downloads
await app.evaluate(({ app }, dir) => app.setPath('downloads', dir), downloads)

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })

  // ---------- the agent writes files and exports one itself
  const t = await api('threads.create', m.id)
  const end = await runAndWait(t.id, '[outputs:T1] 写一份竞品周报，要 Word 版')
  ok(end && !end.error, 'the run finished')
  const list = await api('outputs.list', t.id)
  const names = list.map((f) => f.name).sort()
  ok(names.join(',') === ['价格-T1.csv', '周报-T1.docx', '周报-T1.md'].sort().join(','), `the conversation's outputs are listed (${names.join(', ')})`)
  const md = list.find((f) => f.name === '周报-T1.md')
  const csv = list.find((f) => f.name === '价格-T1.csv')
  ok(md.exports.join() === 'docx,pdf,xlsx' && csv.exports.join() === 'xlsx', 'each knows what it can be exported to')
  const docxPath = join(profile, 'workspace', '周报-T1.docx')
  const docXml = existsSync(docxPath) ? await (await JSZip.loadAsync(readFileSync(docxPath))).file('word/document.xml').async('string') : ''
  ok(docXml.includes('竞品周报 T1') && docXml.includes('<w:tbl>'), "the agent's export_file wrote a real Word document next to the report")
  ok((await api('outputs.list', (await api('threads.create', m.id)).id)).length === 0, 'another conversation has no outputs')

  // ---------- exports (to a chosen place)
  const pdf = await api('outputs.export', md.id, 'pdf', join(exportsDir, 'r.pdf'))
  ok(readFileSync(pdf).subarray(0, 4).toString() === '%PDF', 'Markdown → PDF')
  const xlsx = await api('outputs.export', md.id, 'xlsx', join(exportsDir, 'r.xlsx'))
  const rows = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(xlsx)).Sheets['表格1'], { header: 1 })
  ok(rows[1]?.[1] === 1599, "the report's table → Excel, numbers as numbers")
  const csvX = await api('outputs.export', csv.id, 'xlsx', join(exportsDir, 'c.xlsx'))
  ok(XLSX.utils.sheet_to_json(XLSX.read(readFileSync(csvX)).Sheets.Sheet1, { header: 1 })[2]?.[1] === 2999, 'CSV → Excel')

  // ---------- a download in the conversation's tab
  const before = (await api('outputs.list', t.id)).length
  await runAndWait(t.id, '[nav:http://127.0.0.1:38994/orders.csv] 下载订单 [plain]')
  const dl = await until(async () => (await api('outputs.list', t.id)).find((f) => f.source === 'download'))
  ok(
    dl?.name === 'orders.csv' && dl.path.startsWith(downloads) && (await api('outputs.list', t.id)).length === before + 1,
    'a file downloaded in its tab is one of its outputs',
  )

  // ---------- the dialog
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('evt:quick.openThread', id)
  }, t.id)
  await win.click('[data-testid=outputs-button]', { timeout: 8000 })
  await win.waitForSelector('[data-testid=output-list] li', { timeout: 5000 })
  ok((await win.$$('[data-testid=output-list] li')).length === 4, 'the dialog lists them')
  await win.getByRole('button', { name: /周报-T1\.md/ }).click()
  await win.waitForSelector('[data-testid=output-preview] h1', { timeout: 5000 })
  ok((await win.textContent('[data-testid=output-preview] h1')).includes('竞品周报 T1'), 'Markdown is previewed rendered')
  await sleep(300)
  await win.screenshot({ path: join(out, 'outputs.png') })
  // the save dialog answers with a temp path
  await app.evaluate(
    ({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    },
    join(exportsDir, 'ui.docx'),
  )
  await win.getByRole('button', { name: '导出 Word' }).click()
  await until(async () => existsSync(join(exportsDir, 'ui.docx')))
  ok(existsSync(join(exportsDir, 'ui.docx')), '"导出 Word" saves where the user chose')
  await win.getByRole('button', { name: /价格-T1\.csv/ }).click()
  await win.waitForSelector('[data-testid=output-table]', { timeout: 5000 })
  ok(/产品[\s\S]*2999/.test(await win.textContent('[data-testid=output-table]')), 'CSV is previewed as a table')
  await win.screenshot({ path: join(out, 'outputs-table.png') })
} catch (e) {
  await win.screenshot({ path: join(out, 'outputs-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
  site.close()
}
