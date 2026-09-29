import JSZip from 'jszip'
import { extname } from 'node:path'
import { ocrImage } from './ocr'
import { parseDocx } from './parsers/docx'
import { parseEpub } from './parsers/epub'
import { parseHtml } from './parsers/html'
import { parseOdf, parsePptx } from './parsers/office-xml'
import { parsePdf } from './parsers/pdf'
import { parseSheet } from './parsers/sheet'
import { decodeText, looksBinary, normalizeCjk, tidyMarkdown } from './text-utils'
import { UnsupportedFileError, type FileKind, type ParseOptions, type ParseResult } from './types'
import { writeVisual } from './visuals'

const CODE_EXT: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  proto: 'protobuf',
}
const DATA_EXT: Record<string, string> = {
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  ini: 'ini',
  env: 'bash',
  log: 'text',
}
const TEXT_EXT = new Set(['txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'tex'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'])
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'numbers'])

export const SUPPORTED_EXTENSIONS = [
  'pdf',
  'docx',
  'pptx',
  'odt',
  'odp',
  'epub',
  'html',
  'htm',
  'rtf',
  'csv',
  'tsv',
  'zip',
  ...SHEET_EXT,
  ...IMAGE_EXT,
  ...TEXT_EXT,
  ...Object.keys(CODE_EXT),
  ...Object.keys(DATA_EXT),
]

/** Sniffs formats by magic bytes, so misnamed files (or files without an extension) still parse. */
async function sniff(buf: Buffer, ext: string): Promise<string> {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf'
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return ext === 'doc' || ext === 'ppt' ? ext : 'xls' // legacy OLE2 container
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // zip-based: tell Office / OpenDocument / EPUB apart by their marker files
    try {
      const zip = await JSZip.loadAsync(buf)
      const names = Object.keys(zip.files)
      const mimetype = (await zip.file('mimetype')?.async('string'))?.trim()
      if (mimetype === 'application/epub+zip') return 'epub'
      if (mimetype?.includes('opendocument.text')) return 'odt'
      if (mimetype?.includes('opendocument.presentation')) return 'odp'
      if (mimetype?.includes('opendocument.spreadsheet')) return 'ods'
      if (names.some((n) => n.startsWith('word/'))) return 'docx'
      if (names.some((n) => n.startsWith('ppt/'))) return 'pptx'
      if (names.some((n) => n.startsWith('xl/'))) return 'xlsx'
      return 'zip'
    } catch {
      return ext
    }
  }
  return ext
}

/** Code fence longer than any backtick run inside the content, so embedded ``` can't close it early. */
function fenced(lang: string, body: string): string {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${body.replace(/\s+$/, '')}\n${f}`
}

function rtfToText(rtf: string): string {
  // good enough for typical RTF exports: control words dropped, \uNNNN unicode escapes and \'hh bytes decoded
  return (
    rtf
      // drop destination groups that hold metadata, not text
      .replace(/\{\\(fonttbl|colortbl|stylesheet|info|\*)[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
      .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
      .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\par[d]?\b/g, '\n')
      .replace(/\{\\\*[^{}]*\}/g, '')
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

const ARCHIVE_LIMIT = { files: 50, bytes: 50 * 1024 * 1024 }

async function parseZip(buf: Buffer, opts: ParseOptions): Promise<ParseResult> {
  if ((opts.depth ?? 0) >= 2) throw new UnsupportedFileError('压缩包嵌套过深')
  const zip = await JSZip.loadAsync(buf)
  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name))
  const warnings: string[] = []
  const parts = [`压缩包内共 ${entries.length} 个文件：\n\n${entries.map((e) => `- ${e.name}`).join('\n')}`]
  let total = 0
  let parsed = 0
  for (const e of entries) {
    if (parsed >= ARCHIVE_LIMIT.files || total > ARCHIVE_LIMIT.bytes) {
      warnings.push(`压缩包文件较多，只解析了前 ${parsed} 个`)
      break
    }
    const data = Buffer.from(await e.async('uint8array'))
    total += data.length
    try {
      const r = await parseFile(data, e.name, { ...opts, visualsDir: undefined, depth: (opts.depth ?? 0) + 1 })
      parts.push(`## ${e.name}\n\n${r.markdown}`)
      parsed++
    } catch (err) {
      if (!(err instanceof UnsupportedFileError)) warnings.push(`${e.name}：${(err as Error).message}`)
    }
  }
  return { markdown: tidyMarkdown(parts.join('\n\n')), kind: 'archive', units: entries.length, unitLabel: '个文件', warnings, engine: 'builtin' }
}

/** Parses any supported file into structured Markdown. Throws UnsupportedFileError for unknown binaries. */
export async function parseFile(buf: Buffer, name: string, opts: ParseOptions): Promise<ParseResult> {
  const declared = extname(name).slice(1).toLowerCase() || (name.toLowerCase() === 'dockerfile' ? 'dockerfile' : '')
  const ext = await sniff(buf, declared)
  const done = (kind: FileKind, markdown: string, extra: Partial<ParseResult> = {}): ParseResult => ({
    markdown: tidyMarkdown(markdown),
    kind,
    warnings: [],
    engine: 'builtin',
    ...extra,
  })

  if (ext === 'pdf') return parsePdf(buf, opts)
  if (ext === 'docx') {
    const r = await parseDocx(buf)
    return done('word', r.markdown, { warnings: r.warnings, title: r.title })
  }
  if (ext === 'doc') throw new UnsupportedFileError('暂不支持旧版 Word（.doc），请另存为 .docx 后再上传')
  if (ext === 'ppt') throw new UnsupportedFileError('暂不支持旧版 PowerPoint（.ppt），请另存为 .pptx 后再上传')
  if (ext === 'pptx') {
    const r = await parsePptx(buf)
    return done('slides', r.markdown, { units: r.slides, unitLabel: '张幻灯片' })
  }
  if (ext === 'odt' || ext === 'odp') {
    const r = await parseOdf(buf, ext)
    return done(ext === 'odt' ? 'word' : 'slides', r.markdown, r.units ? { units: r.units, unitLabel: '张幻灯片' } : {})
  }
  if (SHEET_EXT.has(ext)) {
    if (ext === 'numbers') throw new UnsupportedFileError('暂不支持 Numbers 文件，请导出为 .xlsx 或 .csv')
    const r = parseSheet(buf, ext)
    return done('sheet', r.markdown, { units: r.sheets, unitLabel: '个工作表', warnings: r.warnings })
  }
  if (ext === 'csv' || ext === 'tsv') {
    const { text, encoding } = decodeText(buf)
    const r = parseSheet(text, ext)
    const warnings = [...(encoding.startsWith('UTF-8') ? [] : [`已按 ${encoding} 编码读取`]), ...r.warnings]
    return done('sheet', r.markdown, { units: 1, unitLabel: '个工作表', warnings })
  }
  if (ext === 'epub') {
    const r = await parseEpub(buf)
    return done('ebook', r.markdown, { title: r.title, units: r.chapters, unitLabel: '章' })
  }
  if (ext === 'zip') return parseZip(buf, opts)
  if (IMAGE_EXT.has(ext)) {
    if (opts.visualsDir) await writeVisual(buf, opts.visualsDir, 'image')
    if (opts.ocr === false) return done('image', '_（图片，未启用 OCR）_')
    opts.onProgress?.('正在识别图片中的文字…')
    const { text, confidence } = await ocrImage(buf, opts)
    return done('image', text || '_（图片中没有识别到文字）_', {
      warnings: text && confidence < 60 ? [`OCR 置信度较低（${Math.round(confidence)}%），请核对识别结果`] : [],
    })
  }
  if (ext === 'rtf') return done('word', normalizeCjk(rtfToText(decodeText(buf).text)))

  // text-like formats
  if (looksBinary(buf)) throw new UnsupportedFileError(`不支持的文件格式${declared ? `（.${declared}）` : ''}`)
  const { text, encoding } = decodeText(buf)
  const warnings = encoding.startsWith('UTF-8') ? [] : [`已按 ${encoding} 编码读取`]
  if (ext === 'html' || ext === 'htm' || /^\s*<!doctype html|^\s*<html[\s>]/i.test(text)) {
    const r = parseHtml(text)
    return done('html', r.markdown, { title: r.title, warnings })
  }
  if (ext === 'json') {
    try {
      return done('data', fenced('json', JSON.stringify(JSON.parse(text), null, 2)), { warnings })
    } catch {
      warnings.push('JSON 格式有误，按原文保留')
    }
  }
  const lang = CODE_EXT[ext] ?? DATA_EXT[ext]
  if (lang) return done(CODE_EXT[ext] ? 'code' : 'data', fenced(lang, text), { warnings })
  return done('text', normalizeCjk(text), { warnings })
}
