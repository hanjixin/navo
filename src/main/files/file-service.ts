import { app, dialog, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { FileEngine, FileEngineStatus, FileRecord, FileStatus } from '@shared/types'
import type { RpcMessage } from '../agent-host/protocol'
import { Rpc } from '../agent-host/rpc'
import { appFile } from '../core/app-dir'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { secrets } from '../core/secrets'
import { getSettings } from '../core/settings'
import { shellPath } from '../core/shell-env'
import type { ParseResult } from './types'

const MAX_FILE_BYTES = 300 * 1024 * 1024
const CONCURRENCY = 2

interface Row {
  id: string
  name: string
  ext: string
  size: number
  sha256: string
  kind: string | null
  status: FileStatus
  progress: string | null
  error: string | null
  engine: FileEngine | null
  title: string | null
  units: number | null
  unit_label: string | null
  chars: number | null
  warnings: string | null
  ocr_pages: string | null
  created_at: number
  parsed_at: number | null
}

/** Human-readable, filesystem-safe Markdown name for the agent: "<short id>-<original name>.md". */
const mdName = (r: Pick<Row, 'id' | 'name'>) =>
  `${r.id.slice(0, 8)}-${[...r.name].map((c) => ('\\/:*?"<>|'.includes(c) || c.charCodeAt(0) < 32 ? '_' : c)).join('')}.md`

const toRecord = (r: Row): FileRecord => ({
  id: r.id,
  name: r.name,
  ext: r.ext,
  size: r.size,
  kind: r.kind,
  status: r.status,
  progress: r.progress,
  error: r.error,
  engine: r.engine,
  title: r.title,
  units: r.units,
  unitLabel: r.unit_label,
  chars: r.chars,
  warnings: json.parse<string[]>(r.warnings) ?? [],
  ocrPages: json.parse<number[]>(r.ocr_pages) ?? [],
  createdAt: r.created_at,
  parsedAt: r.parsed_at,
  agentPath: `/uploads/${mdName(r)}`,
})

/** pdf.js cmaps / standard fonts ship as extraResources in the packaged app. */
/** OCR language data: shipped in resources/tessdata; in development gathered from the npm packages. */
function ocrLangDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'tessdata')
  const dir = join(paths.ocrCache, 'bundled')
  mkdirSync(dir, { recursive: true })
  for (const l of ['chi_sim', 'eng']) {
    const src = appFile('node_modules', '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`)
    if (existsSync(src) && !existsSync(join(dir, `${l}.traineddata.gz`))) copyFileSync(src, join(dir, `${l}.traineddata.gz`))
  }
  return dir
}
const pdfAssetsDir = () => (app.isPackaged ? join(process.resourcesPath, 'pdfjs') : appFile('node_modules', 'pdfjs-dist'))

class FileService {
  private child: UtilityProcess | null = null
  private rpc: Rpc | null = null
  private queue: { id: string; engine: FileEngine }[] = []
  private active = 0

  private host(): Rpc {
    if (this.rpc && this.child) return this.rpc
    const child = utilityProcess.fork(appFile('out/main/parser-host.js'), [], { serviceName: 'Navo Parser', stdio: 'pipe' })
    child.stdout?.on('data', (d: Buffer) => log.info(`[parser] ${d.toString().trim()}`))
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString().trim()
      // tesseract prints a harmless warning while loading combined language models
      if (!/Error opening data file|TESSDATA_PREFIX|Failed loading language/.test(s)) log.warn(`[parser] ${s}`)
    })
    const rpc = new Rpc({ post: (m) => child.postMessage(m), listen: (fn) => child.on('message', (m: RpcMessage) => fn(m)) }, {}, (name, payload) => {
      if (name === 'progress') {
        const { jobId, message } = payload as { jobId: string; message: string }
        this.update(jobId, { progress: message })
      }
    })
    child.on('exit', (code) => {
      log.warn(`[parser] exited with code ${code}`)
      rpc.failAll('解析进程意外退出（文件可能已损坏或过大）')
      if (this.child === child) {
        this.child = null
        this.rpc = null
      }
    })
    this.child = child
    this.rpc = rpc
    return rpc
  }

  init(): void {
    // jobs interrupted by a quit are re-queued
    const stale = db().prepare("SELECT id, engine FROM files WHERE status IN ('queued', 'parsing')").all() as { id: string; engine: FileEngine | null }[]
    for (const s of stale) this.enqueue(s.id, s.engine ?? getSettings().files.defaultEngine)
  }

  list(): FileRecord[] {
    return (db().prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Row[]).map(toRecord)
  }

  private row(id: string): Row {
    const r = db().prepare('SELECT * FROM files WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error('文件不存在')
    return r
  }

  get(id: string): FileRecord {
    return toRecord(this.row(id))
  }

  private update(id: string, patch: Partial<Omit<Row, 'id'>>): void {
    const keys = Object.keys(patch)
    if (!keys.length) return
    db()
      .prepare(`UPDATE files SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...patch, id })
    const r = db().prepare('SELECT * FROM files WHERE id = ?').get(id) as Row | undefined
    if (r) emit('files.changed', toRecord(r))
  }

  exists(id: string): boolean {
    return !!db().prepare('SELECT 1 FROM files WHERE id = ?').get(id)
  }

  /** Path of the stored original (by id or row). */
  originalPath(r: Pick<Row, 'id' | 'ext'> | string): string {
    if (typeof r === 'string') r = this.row(r)
    return join(paths.files, r.id, `original${r.ext ? `.${r.ext}` : ''}`)
  }

  private visualsDir(id: string): string {
    return join(paths.files, id, 'visual')
  }

  /** Model-ready images written by the parser: the picture itself or scanned PDF pages (in page order). */
  visuals(id: string): string[] {
    const dir = this.visualsDir(id)
    if (!existsSync(dir)) return []
    const order = (f: string) => (f === 'image.jpg' ? 0 : Number(/^page-(\d+)\.jpg$/.exec(f)?.[1] ?? Infinity))
    return readdirSync(dir)
      .filter((f) => f !== 'thumb.jpg' && Number.isFinite(order(f)))
      .sort((a, b) => order(a) - order(b))
      .map((f) => join(dir, f))
  }

  /** The model-ready copy of a picture (≤ 2000px JPEG), as a data URL. */
  image(id: string): string | null {
    const p = join(this.visualsDir(id), 'image.jpg')
    return existsSync(p) ? `data:image/jpeg;base64,${readFileSync(p).toString('base64')}` : null
  }

  /** Small JPEG preview for image-like files, as a data URL (null when there is none). */
  thumbnail(id: string): string | null {
    const p = join(this.visualsDir(id), 'thumb.jpg')
    return existsSync(p) ? `data:image/jpeg;base64,${readFileSync(p).toString('base64')}` : null
  }

  /** Adds a file; identical content that already parsed fine is reused instead of parsed again. */
  private add(name: string, data: Buffer): FileRecord {
    if (data.length > MAX_FILE_BYTES) throw new Error(`${name} 超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限`)
    if (!data.length) throw new Error(`${name} 是空文件`)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const same = db().prepare("SELECT * FROM files WHERE sha256 = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1").get(sha256) as Row | undefined
    if (same) return toRecord(same)
    const id = newId()
    const ext = extname(name).slice(1).toLowerCase()
    const row = { id, name, ext, size: data.length, sha256, status: 'queued' as const, created_at: Date.now() }
    mkdirSync(join(paths.files, id), { recursive: true })
    writeFileSync(this.originalPath(row), data)
    db().prepare('INSERT INTO files(id, name, ext, size, sha256, status, created_at) VALUES(@id, @name, @ext, @size, @sha256, @status, @created_at)').run(row)
    this.enqueue(id, getSettings().files.defaultEngine)
    return this.get(id)
  }

  addPaths(list: string[]): FileRecord[] {
    return list.filter((p) => existsSync(p) && statSync(p).isFile()).map((p) => this.add(basename(p), readFileSync(p)))
  }

  addData(name: string, data: Uint8Array): FileRecord {
    return this.add(name || `粘贴的文件-${Date.now()}`, Buffer.from(data))
  }

  async pick(): Promise<FileRecord[]> {
    const res = await dialog.showOpenDialog({ title: '选择要上传的文件', properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : this.addPaths(res.filePaths)
  }

  reparse(id: string, engine?: FileEngine): FileRecord {
    this.row(id)
    this.update(id, { status: 'queued', error: null, progress: null })
    this.enqueue(id, engine ?? getSettings().files.defaultEngine)
    return this.get(id)
  }

  delete(id: string): void {
    const r = this.row(id)
    rmSync(join(paths.files, id), { recursive: true, force: true })
    rmSync(join(paths.uploads, mdName(r)), { force: true })
    db().prepare('DELETE FROM files WHERE id = ?').run(id)
    emit('files.changed', { ...toRecord(r), status: 'error', error: '__deleted__' })
  }

  reveal(id: string): void {
    shell.showItemInFolder(this.originalPath(this.row(id)))
  }

  markdown(id: string): string {
    const r = this.row(id)
    const p = join(paths.uploads, mdName(r))
    if (!existsSync(p)) throw new Error(r.status === 'error' ? (r.error ?? '解析失败') : '尚未解析完成')
    return readFileSync(p, 'utf8')
  }

  /** Waits until the given files are parsed (or failed). */
  async waitFor(ids: string[], timeoutMs = 10 * 60_000): Promise<FileRecord[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const recs = ids.map((id) => this.get(id))
      if (recs.every((r) => r.status === 'ready' || r.status === 'error') || Date.now() > deadline) return recs
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  // ---------- queue
  private enqueue(id: string, engine: FileEngine): void {
    this.queue = [...this.queue.filter((q) => q.id !== id), { id, engine }]
    this.pump()
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!
      this.active++
      void this.parse(job.id, job.engine).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async parse(id: string, engine: FileEngine): Promise<void> {
    let r: Row
    try {
      r = this.row(id)
    } catch {
      return // deleted while queued
    }
    this.update(id, { status: 'parsing', progress: '正在解析…', error: null })
    const started = Date.now()
    rmSync(this.visualsDir(id), { recursive: true, force: true })
    try {
      const res = await this.host().call<ParseResult>('parse', {
        jobId: id,
        path: this.originalPath(r),
        name: r.name,
        engine,
        shellPath: shellPath(),
        mineruToken: engine === 'mineru' ? (secrets.get('mineru.token') ?? undefined) : undefined,
        mineruBase: process.env.AB_MINERU_BASE,
        options: {
          pdfAssetsDir: pdfAssetsDir(),
          ocrCacheDir: paths.ocrCache,
          ocrLangDir: ocrLangDir(),
          ocr: getSettings().files.ocr,
          visualsDir: this.visualsDir(id),
        },
      })
      writeFileSync(join(paths.uploads, mdName(r)), `# ${r.name}\n\n${res.markdown}\n`)
      this.update(id, {
        status: 'ready',
        progress: null,
        engine: res.engine as FileEngine,
        kind: res.kind,
        title: res.title ?? null,
        units: res.units ?? null,
        unit_label: res.unitLabel ?? null,
        chars: res.markdown.length,
        warnings: json.str(res.warnings),
        ocr_pages: json.str(res.ocrPages ?? []),
        parsed_at: Date.now(),
      })
      log.info(`[files] parsed ${r.name} with ${engine} in ${Date.now() - started}ms`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.update(id, { status: 'error', progress: null, error: message, engine })
      log.warn(`[files] ${r.name}: ${message}`)
    }
  }

  // ---------- engines
  async engines(): Promise<FileEngineStatus[]> {
    const sp = shellPath()
    const has = async (cmd: string) =>
      !!(await this.host()
        .call<string | null>('which', { cmd, shellPath: sp })
        .catch(() => null))
    const [uvx, markitdown, docling] = await Promise.all([has('uvx'), has('markitdown'), has('docling')])
    return [
      { id: 'builtin', name: '内置引擎', description: 'pdf.js / mammoth / SheetJS / Tesseract OCR，离线运行，文件不离开本机', available: true, local: true },
      {
        id: 'markitdown',
        name: 'MarkItDown',
        description: '微软开源，格式覆盖广（含旧版 .doc/.ppt、音频元数据等）',
        available: markitdown || uvx,
        hint: markitdown || uvx ? (markitdown ? '已安装' : '将通过 uvx 自动安装') : '需要安装 uv（推荐）或 pipx install "markitdown[all]"',
        local: true,
      },
      {
        id: 'docling',
        name: 'Docling',
        description: 'IBM 开源，PDF 版面分析、复杂表格与公式效果好（首次需下载约 1GB 模型）',
        available: docling || uvx,
        hint: docling || uvx ? (docling ? '已安装' : '将通过 uvx 自动安装') : '需要安装 uv（推荐）或 pipx install docling',
        local: true,
      },
      {
        id: 'mineru',
        name: 'MinerU 云端',
        description: '中文 PDF（版面、表格、公式）效果最好；文件会上传到 mineru.net',
        available: secrets.has('mineru.token'),
        hint: secrets.has('mineru.token') ? undefined : '需要填写 MinerU API Token',
        local: false,
      },
    ]
  }

  shutdown(): void {
    this.child?.kill()
  }
}

export const files = new FileService()
