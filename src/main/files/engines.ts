import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import type { FileEngine } from '@shared/types'
import { parseFile } from './parse'
import { normalizeCjk, tidyMarkdown } from './text-utils'
import type { ParseOptions, ParseResult } from './types'
import { writeVisual } from './visuals'

export interface EngineJob {
  path: string
  name: string
  engine: FileEngine
  options: ParseOptions
  shellPath: string
  mineruToken?: string
  mineruBase?: string
}

const TEN_MIN = 10 * 60_000

function run(cmd: string, args: string[], shellPath: string, timeout = TEN_MIN): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, PATH: shellPath }, timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${basename(cmd)} 运行失败：${(stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')}`))
      else resolve(stdout)
    })
  })
}

/** First existing command on PATH, e.g. `markitdown` installed with pipx, else null. */
export async function which(cmd: string, shellPath: string): Promise<string | null> {
  try {
    return (await run('/usr/bin/which', [cmd], shellPath, 5000)).trim() || null
  } catch {
    return null
  }
}

const external = (markdown: string, engine: FileEngine, warnings: string[] = []): ParseResult => ({
  markdown: tidyMarkdown(normalizeCjk(markdown)),
  kind: 'unknown',
  warnings,
  engine,
})

/** Microsoft MarkItDown (Python): `markitdown <file>` prints Markdown. */
async function markitdown(job: EngineJob): Promise<ParseResult> {
  const direct = await which('markitdown', job.shellPath)
  if (direct) return external(await run(direct, [job.path], job.shellPath), 'markitdown')
  const uvx = await which('uvx', job.shellPath)
  if (!uvx) throw new Error('未找到 markitdown 或 uv。请先安装 uv（https://docs.astral.sh/uv/），或 `pipx install "markitdown[all]"`')
  job.options.onProgress?.('正在通过 uvx 运行 MarkItDown（首次会自动安装）…')
  return external(await run(uvx, ['--from', 'markitdown[all]', 'markitdown', job.path], job.shellPath), 'markitdown')
}

/** IBM Docling (Python): layout-aware PDF/Office conversion with table structure and OCR. */
async function docling(job: EngineJob): Promise<ParseResult> {
  const out = mkdtempSync(join(tmpdir(), 'navo-docling-'))
  try {
    const args = [job.path, '--to', 'md', '--output', out]
    const direct = await which('docling', job.shellPath)
    if (direct) await run(direct, args, job.shellPath, 30 * 60_000)
    else {
      const uvx = await which('uvx', job.shellPath)
      if (!uvx) throw new Error('未找到 docling 或 uv。请先安装 uv（https://docs.astral.sh/uv/），或 `pipx install docling`')
      job.options.onProgress?.('正在通过 uvx 运行 Docling（首次需下载模型，可能需要几分钟）…')
      await run(uvx, ['--from', 'docling', 'docling', ...args], job.shellPath, 30 * 60_000)
    }
    const md = readdirSync(out).find((f) => f.endsWith('.md'))
    if (!md) throw new Error('Docling 没有输出 Markdown')
    return external(readFileSync(join(out, md), 'utf8'), 'docling')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

/**
 * MinerU cloud API (https://mineru.net): request an upload URL, upload, poll the batch result and
 * read full.md from the result archive. The file leaves this computer.
 */
async function mineru(job: EngineJob): Promise<ParseResult> {
  if (!job.mineruToken) throw new Error('请先在「文件 → 解析引擎」中填写 MinerU API Token')
  const base = (job.mineruBase || 'https://mineru.net').replace(/\/+$/, '')
  const headers = { Authorization: `Bearer ${job.mineruToken}`, 'Content-Type': 'application/json' }
  const json = async (res: Response) => {
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: Record<string, unknown> }
    if (!res.ok || (body.code != null && body.code !== 0)) throw new Error(`MinerU：${body.msg ?? `HTTP ${res.status}`}`)
    return body.data ?? {}
  }
  job.options.onProgress?.('正在上传到 MinerU…')
  const batch = await json(
    await fetch(`${base}/api/v4/file-urls/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        files: [{ name: job.name, is_ocr: true, data_id: basename(job.path) }],
        enable_formula: true,
        enable_table: true,
        language: 'ch',
      }),
    }),
  )
  const uploadUrl = (batch.file_urls as string[] | undefined)?.[0]
  const batchId = batch.batch_id as string | undefined
  if (!uploadUrl || !batchId) throw new Error('MinerU 没有返回上传地址')
  const up = await fetch(uploadUrl, { method: 'PUT', body: readFileSync(job.path) })
  if (!up.ok) throw new Error(`MinerU 上传失败：HTTP ${up.status}`)
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const data = await json(await fetch(`${base}/api/v4/extract-results/batch/${batchId}`, { headers }))
    const r = (
      data.extract_result as
        { state: string; err_msg?: string; full_zip_url?: string; extract_progress?: { extracted_pages?: number; total_pages?: number } }[] | undefined
    )?.[0]
    if (!r) continue
    if (r.state === 'failed') throw new Error(`MinerU 解析失败：${r.err_msg ?? '未知错误'}`)
    if (r.state === 'done' && r.full_zip_url) {
      const zip = await JSZip.loadAsync(Buffer.from(await (await fetch(r.full_zip_url)).arrayBuffer()))
      const md = zip.file('full.md') ?? Object.values(zip.files).find((f) => f.name.endsWith('.md'))
      if (!md) throw new Error('MinerU 结果中没有 Markdown')
      return external(await md.async('string'), 'mineru')
    }
    const pr = r.extract_progress
    job.options.onProgress?.(pr?.total_pages ? `MinerU 解析中 ${pr.extracted_pages ?? 0}/${pr.total_pages} 页` : 'MinerU 排队解析中…')
  }
  throw new Error('MinerU 解析超时')
}

export async function runEngine(job: EngineJob): Promise<ParseResult> {
  if (job.engine === 'builtin') return parseFile(readFileSync(job.path), job.name, job.options)
  // external engines produce Markdown; we still classify the file with the built-in sniffer's view
  const res = job.engine === 'markitdown' ? await markitdown(job) : job.engine === 'docling' ? await docling(job) : await mineru(job)
  const kind = guessKind(job.name)
  if (kind === 'image' && job.options.visualsDir) await writeVisual(readFileSync(job.path), job.options.visualsDir, 'image')
  return { ...res, kind }
}

function guessKind(name: string): ParseResult['kind'] {
  const e = extname(name).slice(1).toLowerCase()
  if (e === 'pdf') return 'pdf'
  if (['doc', 'docx', 'odt', 'rtf'].includes(e)) return 'word'
  if (['xls', 'xlsx', 'ods', 'csv'].includes(e)) return 'sheet'
  if (['ppt', 'pptx', 'odp'].includes(e)) return 'slides'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(e)) return 'image'
  return 'unknown'
}
