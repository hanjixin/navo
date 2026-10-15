import { BrowserWindow, dialog, shell } from 'electron'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import * as XLSX from 'xlsx'
import type { DownloadInfo, ExportFormat, OutputFile, OutputPreview } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { files } from '../files/file-service'
import { decodeText } from '../files/text-utils'
import { exportTargets, kindOf, markdownToDocx, markdownToHtml, toXlsx } from './convert'
import { t } from '@shared/i18n'

interface Row {
  id: string
  thread_id: string
  path: string
  source: 'agent' | 'download'
  size: number
  at: number
}

/** text previews stop here */
const MAX_TEXT = 400_000
const MAX_IMAGE = 15 * 1024 * 1024
const MAX_ROWS = 300
/** a run that wrote more files than this is a bulk job: only the most recent are listed */
const MAX_PER_RUN = 100

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

/** /workspace/… for the agent's files (that is how the agent and the user refer to them) */
const VIRTUAL = '/workspace/'
const absOf = (p: string) => (p.startsWith(VIRTUAL) ? join(paths.workspace, ...p.slice(VIRTUAL.length).split('/')) : p)
const virtualOf = (abs: string) => VIRTUAL + relative(paths.workspace, abs).split(sep).join('/')

/**
 * What conversations produced: files the agent wrote under /workspace/ during a run and files
 * downloaded in its tab — previewed in the app and exported to Word, PDF or Excel.
 */
class OutputsService {
  private runStart = new Map<string, number>()

  onRunStart(threadId: string): void {
    this.runStart.set(threadId, Date.now())
  }

  /** Files under /workspace/ changed during the run belong to this conversation. */
  onRunEnd(threadId: string): void {
    const since = this.runStart.get(threadId)
    this.runStart.delete(threadId)
    if (since == null) return
    const found: { abs: string; size: number; mtime: number }[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || found.length > 2000) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules') continue
        const abs = join(dir, name)
        try {
          const st = statSync(abs)
          if (st.isDirectory()) walk(abs, depth + 1)
          // a second of slack: some file systems store whole seconds
          else if (st.mtimeMs >= since - 1000) found.push({ abs, size: st.size, mtime: st.mtimeMs })
        } catch {
          /* vanished while looking */
        }
      }
    }
    walk(paths.workspace, 0)
    found.sort((a, b) => b.mtime - a.mtime)
    for (const f of found.slice(0, MAX_PER_RUN)) this.upsert(threadId, virtualOf(f.abs), 'agent', f.size)
    if (found.length) emit('outputs.changed', { threadId })
  }

  /** A finished download in a conversation's tab. */
  onDownload(d: DownloadInfo, threadId: string | null): void {
    if (d.state !== 'completed' || !threadId || !d.path) return
    this.upsert(threadId, d.path, 'download', d.received || d.total)
    emit('outputs.changed', { threadId })
  }

  private upsert(threadId: string, path: string, source: Row['source'], size: number): void {
    db()
      .prepare(
        `INSERT INTO outputs(id, thread_id, path, source, size, at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, path) DO UPDATE SET size = excluded.size, at = excluded.at`,
      )
      .run(newId(), threadId, path, source, size, Date.now())
  }

  private row(id: string): Row {
    const r = db().prepare('SELECT * FROM outputs WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error(t('产出文件不存在'))
    return r
  }

  private toFile(r: Row): OutputFile {
    const abs = absOf(r.path)
    const missing = !existsSync(abs)
    const name = basename(r.path)
    // whether Markdown has tables / JSON is tabular decides the targets: read small files only
    let text: string | undefined
    if (!missing && r.size < 2_000_000 && /\.(md|markdown|txt|json)$/i.test(name)) text = decodeText(readFileSync(abs)).text
    return {
      id: r.id,
      threadId: r.thread_id,
      name,
      path: r.path,
      source: r.source,
      kind: kindOf(name),
      size: missing ? r.size : statSync(abs).size,
      at: r.at,
      missing,
      exports: missing ? [] : exportTargets(name, text),
    }
  }

  list(threadId: string): OutputFile[] {
    return (db().prepare('SELECT * FROM outputs WHERE thread_id = ? ORDER BY at DESC').all(threadId) as Row[]).map((r) => this.toFile(r))
  }

  counts(): Record<string, number> {
    return Object.fromEntries(
      (db().prepare('SELECT thread_id, COUNT(*) AS n FROM outputs GROUP BY thread_id').all() as { thread_id: string; n: number }[]).map((r) => [
        r.thread_id,
        r.n,
      ]),
    )
  }

  async preview(id: string): Promise<OutputPreview> {
    const r = this.row(id)
    const abs = absOf(r.path)
    if (!existsSync(abs)) return { kind: 'other', message: t('文件已被删除或移走') }
    const name = basename(abs)
    const kind = kindOf(name)
    const text = () => {
      const all = decodeText(readFileSync(abs)).text
      return { text: all.slice(0, MAX_TEXT), truncated: all.length > MAX_TEXT }
    }
    switch (kind) {
      case 'markdown':
      case 'text':
      case 'json':
        return { kind, ...text() }
      case 'html':
        return { kind, html: decodeText(readFileSync(abs)).text }
      case 'table': {
        const buf = readFileSync(abs)
        // CSV is text (UTF-8 or GBK); spreadsheets are read as files
        const wb = /\.(csv|tsv)$/i.test(name) ? XLSX.read(decodeText(buf).text, { type: 'string', raw: true }) : XLSX.read(buf, { type: 'buffer' })
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' })
        return {
          kind,
          rows: rows.slice(0, MAX_ROWS).map((row) => row.map((c) => String(c ?? ''))),
          sheets: wb.SheetNames.length > 1 ? wb.SheetNames : undefined,
          truncated: rows.length > MAX_ROWS,
        }
      }
      case 'image': {
        const size = statSync(abs).size
        if (size > MAX_IMAGE) return { kind: 'other', message: t('图片太大，请用其他应用打开') }
        return { kind, dataUrl: `data:${MIME[extname(name).slice(1).toLowerCase()] ?? 'image/png'};base64,${readFileSync(abs).toString('base64')}` }
      }
      case 'pdf':
      case 'document':
        return { kind, markdown: await files.markdownOf(abs, name) }
      default:
        return { kind: 'other', message: t('这种文件无法预览，可以用默认应用打开') }
    }
  }

  /** Converts a file; returns the bytes and the name the result would get. */
  async convert(abs: string, format: ExportFormat): Promise<{ data: Buffer; name: string }> {
    const name = basename(abs)
    const stem = name.replace(/\.[^.]+$/, '')
    const kind = kindOf(name)
    const content = readFileSync(abs)
    if (format === 'xlsx') return { data: toXlsx(name, content), name: `${stem}.xlsx` }
    const md = decodeText(content).text
    if (format === 'docx') {
      if (kind !== 'markdown' && kind !== 'text') throw new Error(t('只有 Markdown 或文本可以导出为 Word'))
      return { data: await markdownToDocx(kind === 'text' ? md.replace(/\n/g, '  \n') : md, stem), name: `${stem}.docx` }
    }
    if (kind !== 'markdown' && kind !== 'text' && kind !== 'html') throw new Error(t('只有 Markdown、文本或 HTML 可以导出为 PDF'))
    const html = kind === 'html' ? md : markdownToHtml(kind === 'text' ? `\`\`\`\n${md}\n\`\`\`` : md, stem)
    return { data: await printToPdf(html), name: `${stem}.pdf` }
  }

  /**
   * Exports an output. Without `dest`, asks where to save; with `dest: 'beside'`, writes next to the
   * original (the agent's export_file does that). Returns where it went, or null when cancelled.
   */
  async export(id: string, format: ExportFormat, dest?: string): Promise<string | null> {
    const r = this.row(id)
    const abs = absOf(r.path)
    if (!existsSync(abs)) throw new Error(t('文件已被删除或移走'))
    const { data, name } = await this.convert(abs, format)
    let target = dest === 'beside' ? join(dirname(abs), name) : dest
    if (!target) {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: name, filters: [{ name: format.toUpperCase(), extensions: [format] }] }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      target = res.filePath
    }
    writeFileSync(target, data)
    // a converted file inside the workspace is an output too
    if (target.startsWith(paths.workspace)) {
      this.upsert(r.thread_id, virtualOf(target), 'agent', data.length)
      emit('outputs.changed', { threadId: r.thread_id })
    }
    log.info(`[outputs] exported ${r.path} → ${target}`)
    return target
  }

  async saveAs(id: string): Promise<string | null> {
    const abs = absOf(this.row(id).path)
    const win = BrowserWindow.getFocusedWindow()
    const opts = { defaultPath: basename(abs) }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    copyFileSync(abs, res.filePath)
    return res.filePath
  }

  reveal(id: string): void {
    shell.showItemInFolder(absOf(this.row(id).path))
  }

  async open(id: string): Promise<void> {
    const err = await shell.openPath(absOf(this.row(id).path))
    if (err) throw new Error(err)
  }

  /** For the agent's export_file: /workspace/report.md → /workspace/report.docx */
  async exportWorkspaceFile(threadId: string, virtualPath: string, format: ExportFormat): Promise<string> {
    if (!virtualPath.startsWith(VIRTUAL)) throw new Error(t('只能导出 /workspace/ 下的文件'))
    const abs = absOf(virtualPath)
    if (relative(paths.workspace, abs).startsWith('..')) throw new Error(t('只能导出 /workspace/ 下的文件'))
    if (!existsSync(abs)) throw new Error(t('文件不存在：{{v0}}', { v0: virtualPath }))
    const { data, name } = await this.convert(abs, format)
    const target = join(dirname(abs), name)
    writeFileSync(target, data)
    this.upsert(threadId, virtualOf(abs), 'agent', statSync(abs).size)
    this.upsert(threadId, virtualOf(target), 'agent', data.length)
    emit('outputs.changed', { threadId })
    return virtualOf(target)
  }

  forget(threadId: string): void {
    db().prepare('DELETE FROM outputs WHERE thread_id = ?').run(threadId)
  }
}

/** HTML → PDF in a hidden window (Chromium's print engine: CJK, tables and page breaks just work). */
async function printToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, offscreen: false } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`)
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
  } finally {
    win.destroy()
  }
}

export const outputs = new OutputsService()
