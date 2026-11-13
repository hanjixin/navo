import type { ArtifactsQuery, ArtifactsPage } from '@shared/files-query'
import { BrowserWindow, dialog, shell } from 'electron'
import { closeSync, copyFileSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import * as XLSX from 'xlsx'
import type { Artifact, DownloadInfo, ExportFormat, OutputFile, OutputPreview } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { files } from '../files/file-service'
import { decodeText } from '../files/text-utils'
import { exportTargets, kindOf, markdownToDocx, markdownToHtml, toXlsx } from './convert'
import { insideWorkspace, workspaceFile, storedWorkspacePath, outputAbsolutePath } from './workspace-paths'
import { t } from '@shared/i18n'
import { createHash } from 'node:crypto'

interface Row {
  id: string
  thread_id: string
  path: string
  source: 'agent' | 'download'
  size: number
  at: number
  workspace_root: string | null
  run_id: string | null
  execution_id: string | null
  message_id: string | null
  content_hash: string | null
}

/** text previews stop here */
const MAX_TEXT = 400_000
const MAX_IMAGE = 15 * 1024 * 1024
const MAX_ROWS = 300
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

/** /workspace/… for the agent's files (that is how the agent and the user refer to them) */
const VIRTUAL = '/workspace/'
const absOf = (row: Row) => outputAbsolutePath(row, paths.workspace)
const virtualOf = (abs: string, root: string) => VIRTUAL + relative(root, abs).split(sep).join('/')
const storedPath = (abs: string, root: string) => storedWorkspacePath(abs, root, paths.workspace)

/**
 * What conversations produced: files the agent wrote under /workspace/ during a run and files
 * downloaded in its tab — previewed in the app and exported to Word, PDF or Excel.
 */
class OutputsService {
  recordWorkspaceWrite(
    threadId: string,
    path: string,
    workspaceRoot = paths.workspace,
    provenance: { runId?: string; executionId?: string; messageId?: string } = {},
  ): void {
    let abs: string
    if (!db().prepare('SELECT 1 FROM threads WHERE id=?').get(threadId)) return
    let stat: ReturnType<typeof statSync>
    try {
      abs = workspaceFile(workspaceRoot, path)
      stat = statSync(abs)
    } catch (error) {
      // A file can disappear after a successful write; indexing errors must reach the caller.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isFile()) return
    this.upsert(threadId, storedPath(abs, workspaceRoot), 'agent', Number(stat.size), workspaceRoot, provenance)
    emit('outputs.changed', { threadId })
  }

  /** A finished download in a conversation's tab. */
  onDownload(d: DownloadInfo, threadId: string | null): void {
    if (d.state !== 'completed' || !threadId || !d.path) return
    this.upsert(threadId, d.path, 'download', d.received || d.total)
    emit('outputs.changed', { threadId })
  }

  private upsert(
    threadId: string,
    path: string,
    source: Row['source'],
    size: number,
    workspaceRoot: string | null = null,
    provenance: { runId?: string; executionId?: string; messageId?: string } = {},
  ): void {
    let contentHash: string | null = null
    try {
      const abs = outputAbsolutePath({ path, workspace_root: workspaceRoot, thread_id: threadId } as Row, paths.workspace)
      if (statSync(abs).isFile()) contentHash = createHash('sha256').update(readFileSync(abs)).digest('hex')
    } catch {
      /* provenance is best effort */
    }
    db()
      .prepare(
        `INSERT INTO outputs(id, thread_id, path, source, size, at, workspace_root, name, kind, run_id, execution_id, message_id, content_hash) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, path) DO UPDATE SET size = excluded.size, at = excluded.at, workspace_root = excluded.workspace_root, name = excluded.name, kind = excluded.kind, run_id = excluded.run_id, execution_id = excluded.execution_id, message_id = excluded.message_id, content_hash = excluded.content_hash`,
      )
      .run(
        newId(),
        threadId,
        path,
        source,
        size,
        Date.now(),
        workspaceRoot,
        basename(path),
        kindOf(path),
        provenance.runId ?? null,
        provenance.executionId ?? null,
        provenance.messageId ?? null,
        contentHash,
      )
    emit('artifacts.changed')
    emit('projects.changed')
  }

  private row(id: string): Row {
    const r = db().prepare('SELECT * FROM outputs WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error(t('产出文件不存在'))
    return r
  }

  private toFile(r: Row, readContent = true): OutputFile {
    const name = basename(r.path)
    let size = r.size
    let unavailableReason: OutputFile['unavailableReason']
    let text: string | undefined
    let fd: number | undefined
    let contentChanged = false
    try {
      const abs = absOf(r)
      // Reject directories/special files before opening, then inspect the opened file too.
      if (!statSync(abs).isFile()) throw new Error('Not a regular file')
      if (!readContent) {
        size = statSync(abs).size
        if (r.content_hash && size <= 20 * 1024 * 1024) contentChanged = createHash('sha256').update(readFileSync(abs)).digest('hex') !== r.content_hash
        return {
          id: r.id,
          threadId: r.thread_id,
          name,
          path: r.path,
          source: r.source,
          kind: kindOf(name),
          size,
          at: r.at,
          missing: false,
          ...(contentChanged ? { contentChanged: true } : {}),
          exports: exportTargets(name),
        }
      }
      fd = openSync(abs, 'r')
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error('Not a regular file')
      size = stat.size
      if (r.content_hash && size <= 20 * 1024 * 1024) contentChanged = createHash('sha256').update(readFileSync(abs)).digest('hex') !== r.content_hash
      // Never trust the indexed size: an external editor may have enlarged the file.
      if (size < 2_000_000 && /\.(md|markdown|txt|json)$/i.test(name)) {
        const buffer = Buffer.alloc(size)
        const length = readSync(fd, buffer, 0, buffer.length, 0)
        text = decodeText(buffer.subarray(0, length)).text
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      unavailableReason = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          unavailableReason ??= 'unreadable'
        }
      }
    }
    return {
      id: r.id,
      threadId: r.thread_id,
      name,
      path: r.path,
      source: r.source,
      kind: kindOf(name),
      size,
      at: r.at,
      missing: unavailableReason === 'missing',
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(contentChanged ? { contentChanged: true } : {}),
      exports: unavailableReason ? [] : exportTargets(name, text),
    }
  }

  list(threadId: string): OutputFile[] {
    return (db().prepare('SELECT * FROM outputs WHERE thread_id = ? ORDER BY at DESC').all(threadId) as Row[]).map((r) => this.toFile(r))
  }

  artifacts(projectId?: string | null): Artifact[] {
    const where = projectId === undefined ? '' : projectId === null ? 'WHERE t.project_id IS NULL' : 'WHERE t.project_id = ?'
    const rows = db()
      .prepare(
        `SELECT o.*, t.title AS thread_title, t.project_id, p.name AS project_name FROM outputs o JOIN threads t ON t.id=o.thread_id LEFT JOIN projects p ON p.id=t.project_id ${where} ORDER BY o.at DESC`,
      )
      .all(...(projectId !== undefined && projectId !== null ? [projectId] : [])) as (Row & {
      thread_title: string
      project_id: string | null
      project_name: string | null
    })[]
    return rows.map((r) => ({
      ...this.toFile(r),
      projectId: r.project_id,
      projectName: r.project_name,
      threadTitle: r.thread_title,
      runId: r.run_id,
      executionId: r.execution_id,
      messageId: r.message_id,
      contentHash: r.content_hash,
    }))
  }

  query(query: ArtifactsQuery = {}): ArtifactsPage {
    const where: string[] = []
    const args: (string | number)[] = []
    if (query.projectId === null) where.push('t.project_id IS NULL')
    else if (query.projectId !== undefined) {
      where.push('t.project_id=?')
      args.push(query.projectId)
    }
    if (query.threadId) {
      where.push('o.thread_id=?')
      args.push(query.threadId)
    }
    if (query.kind) {
      where.push('o.kind=?')
      args.push(query.kind)
    }
    if (query.q?.trim()) {
      where.push("instr(lower(o.name || ' ' || t.title || ' ' || coalesce(p.name,'')),lower(?))>0")
      args.push(query.q.trim())
    }
    const scope = JSON.stringify([query.projectId === undefined, query.projectId, query.threadId, query.q?.trim() ?? '', query.kind])
    if (query.cursor) {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as { at: number; id: string; scope: string }
      if (cursor.scope !== scope || !Number.isFinite(cursor.at) || typeof cursor.id !== 'string') throw new Error('Invalid artifact cursor')
      where.push('(o.at < ? OR (o.at = ? AND o.id < ?))')
      args.push(cursor.at, cursor.at, cursor.id)
    }
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.floor(query.limit!))) : 50
    const rows = db()
      .prepare(
        `SELECT o.*, t.title AS thread_title, t.project_id, p.name AS project_name
      FROM outputs o JOIN threads t ON t.id=o.thread_id LEFT JOIN projects p ON p.id=t.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.at DESC,o.id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as (Row & { thread_title: string; project_id: string | null; project_name: string | null })[]
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => ({
        ...this.toFile(row, false),
        projectId: row.project_id,
        projectName: row.project_name,
        threadTitle: row.thread_title,
        runId: row.run_id,
        executionId: row.execution_id,
        messageId: row.message_id,
        contentHash: row.content_hash,
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id, scope })).toString('base64url') : null,
    }
  }

  artifact(id: string): Artifact | null {
    const row = db()
      .prepare(
        `SELECT o.*, t.title AS thread_title, t.project_id, p.name AS project_name
      FROM outputs o JOIN threads t ON t.id=o.thread_id LEFT JOIN projects p ON p.id=t.project_id WHERE o.id=?`,
      )
      .get(id) as (Row & { thread_title: string; project_id: string | null; project_name: string | null }) | undefined
    return row
      ? {
          ...this.toFile(row),
          projectId: row.project_id,
          projectName: row.project_name,
          threadTitle: row.thread_title,
          runId: row.run_id,
          executionId: row.execution_id,
          messageId: row.message_id,
          contentHash: row.content_hash,
        }
      : null
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
    return this.previewFile(absOf(this.row(id)))
  }

  async previewFile(abs: string): Promise<OutputPreview> {
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
    const abs = absOf(r)
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
    const workspaceRoot = r.workspace_root ?? paths.workspace
    if (insideWorkspace(workspaceRoot, target)) workspaceFile(workspaceRoot, relative(workspaceRoot, target), true)
    writeFileSync(target, data)
    // a converted file inside the original workspace is an output too
    if (insideWorkspace(workspaceRoot, target)) {
      workspaceFile(workspaceRoot, relative(workspaceRoot, target))
      this.upsert(r.thread_id, storedPath(target, workspaceRoot), 'agent', data.length, workspaceRoot)
      emit('outputs.changed', { threadId: r.thread_id })
    }
    log.info(`[outputs] exported ${r.path} → ${target}`)
    return target
  }

  async saveAs(id: string): Promise<string | null> {
    const abs = absOf(this.row(id))
    const win = BrowserWindow.getFocusedWindow()
    const opts = { defaultPath: basename(abs) }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    copyFileSync(abs, res.filePath)
    return res.filePath
  }

  reveal(id: string): void {
    shell.showItemInFolder(absOf(this.row(id)))
  }

  async open(id: string): Promise<void> {
    const err = await shell.openPath(absOf(this.row(id)))
    if (err) throw new Error(err)
  }

  /** For the agent's export_file: /workspace/report.md → /workspace/report.docx */
  async exportWorkspaceFile(threadId: string, virtualPath: string, format: ExportFormat, workspaceRoot = paths.workspace): Promise<string> {
    if (!virtualPath.startsWith(VIRTUAL)) throw new Error(t('只能导出 /workspace/ 下的文件'))
    const abs = workspaceFile(workspaceRoot, virtualPath.slice(VIRTUAL.length))
    if (!existsSync(abs)) throw new Error(t('文件不存在：{{v0}}', { v0: virtualPath }))
    const { data, name } = await this.convert(abs, format)
    const target = join(dirname(abs), name)
    workspaceFile(workspaceRoot, relative(workspaceRoot, target), true)
    writeFileSync(target, data)
    this.upsert(threadId, storedPath(abs, workspaceRoot), 'agent', statSync(abs).size, workspaceRoot)
    this.upsert(threadId, storedPath(target, workspaceRoot), 'agent', data.length, workspaceRoot)
    emit('outputs.changed', { threadId })
    return virtualOf(target, workspaceRoot)
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
