import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { marked, type Token, type Tokens } from 'marked'
import * as XLSX from 'xlsx'
import type { ExportFormat, OutputKind } from '@shared/types'
import { decodeText } from '../files/text-utils'
import { t } from '@shared/i18n'

/**
 * Turning what the agent produced into files people use: Markdown → Word / HTML (for PDF),
 * tables (CSV, JSON, Markdown tables) → Excel. No Electron imports (PDF printing lives in the service).
 */

export type { ExportFormat, OutputKind } from '@shared/types'

const EXT: Record<string, OutputKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  csv: 'table',
  tsv: 'table',
  xlsx: 'table',
  xls: 'table',
  json: 'json',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  pdf: 'pdf',
  docx: 'document',
  doc: 'document',
  pptx: 'document',
  txt: 'text',
  log: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  js: 'text',
  ts: 'text',
  py: 'text',
  sh: 'text',
  sql: 'text',
}

export const kindOf = (name: string): OutputKind => EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'other'

/** What a file can be exported to (besides being saved as is). */
export function exportTargets(name: string, text?: string): ExportFormat[] {
  const kind = kindOf(name)
  const ext = name.split('.').pop()?.toLowerCase()
  if (kind === 'markdown' || kind === 'text') return ['docx', 'pdf', ...(text && markdownTables(text).length ? (['xlsx'] as const) : [])]
  if (kind === 'html') return ['pdf']
  if (kind === 'table' && (ext === 'csv' || ext === 'tsv')) return ['xlsx']
  if (kind === 'json' && text && jsonRows(text)) return ['xlsx']
  return []
}

// ---------- tables

/** Rows of a JSON file that is (or contains) a list of records or a list of rows. */
export function jsonRows(text: string): unknown[][] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = Object.values(data).find(Array.isArray)
  if (!Array.isArray(data) || !data.length) return null
  if (data.every(Array.isArray)) return data as unknown[][]
  if (!data.every((r) => r && typeof r === 'object')) return null
  const cols = [...new Set(data.flatMap((r) => Object.keys(r as object)))]
  const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v)
  return [cols, ...data.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])))]
}

/** The tables in a Markdown text, as rows (header first). */
export function markdownTables(md: string): string[][][] {
  return marked
    .lexer(md)
    .filter((tok): tok is Tokens.Table => tok.type === 'table')
    .map((tok) => [tok.header.map((c) => c.text), ...tok.rows.map((r) => r.map((c) => c.text))])
}

/** Numbers that were written as text become numbers, so Excel can sum them. */
const typed = (v: unknown) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 16 ? Number(v) : v)

function workbook(sheets: { name: string; rows: unknown[][] }[]): Buffer {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows.map((r) => r.map(typed))), s.name.slice(0, 31))
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

export function toXlsx(name: string, content: Buffer): Buffer {
  const kind = kindOf(name)
  // UTF-8, or GBK as old systems export it
  const text = decodeText(content).text
  if (kind === 'table') {
    // CSV / TSV: SheetJS reads them (and guesses the delimiter)
    const wb = XLSX.read(text, { type: 'string', raw: true })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false })
    return workbook([{ name: 'Sheet1', rows }])
  }
  if (kind === 'json') {
    const rows = jsonRows(text)
    if (!rows) throw new Error(t('这个 JSON 不是表格数据（需要一组记录或一组行）'))
    return workbook([{ name: 'Sheet1', rows }])
  }
  const tables = markdownTables(text)
  if (!tables.length) throw new Error(t('这个文件里没有表格'))
  return workbook(tables.map((rows, i) => ({ name: t('表格{{v0}}', { v0: i + 1 }), rows })))
}

// ---------- Markdown → HTML (for previews of HTML / printing to PDF)

const PRINT_CSS = `
  body { font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #1f2329; margin: 0; padding: 32px 40px; }
  h1, h2, h3, h4 { line-height: 1.35; margin: 1.4em 0 .6em; } h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
  p, ul, ol, table, pre, blockquote { margin: 0 0 .9em; }
  table { border-collapse: collapse; width: 100%; font-size: .92em; } th, td { border: 1px solid #d0d3d9; padding: 5px 9px; text-align: left; vertical-align: top; } th { background: #f3f4f6; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: .9em; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f6f7f9; padding: 12px 14px; border-radius: 6px; overflow: auto; } pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d0d3d9; padding-left: 12px; color: #555; } a { color: #2f5bd8; } hr { border: 0; border-top: 1px solid #e3e5e8; }
  img { max-width: 100%; } @page { margin: 16mm 14mm; } h1, h2, h3 { break-after: avoid; } tr, img { break-inside: avoid; }`

export function markdownToHtml(md: string, title: string): string {
  const body = marked.parse(md, { async: false, gfm: true }) as string
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ---------- Markdown → Word

const FONT = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei', cs: 'Calibri' }
const MONO = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Microsoft YaHei', cs: 'Consolas' }
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
]

interface RunStyle {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
}

const unescape = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

function inline(tokens: Token[] | undefined, style: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = []
  const run = (text: string, s: RunStyle) =>
    new TextRun({
      text: unescape(text),
      bold: s.bold,
      italics: s.italics,
      strike: s.strike,
      font: s.code ? MONO : undefined,
      shading: s.code ? { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } : undefined,
    })
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'strong':
        out.push(...inline((tok as Tokens.Strong).tokens, { ...style, bold: true }))
        break
      case 'em':
        out.push(...inline((tok as Tokens.Em).tokens, { ...style, italics: true }))
        break
      case 'del':
        out.push(...inline((tok as Tokens.Del).tokens, { ...style, strike: true }))
        break
      case 'codespan':
        out.push(run((tok as Tokens.Codespan).text, { ...style, code: true }))
        break
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }))
        break
      case 'link': {
        const l = tok as Tokens.Link
        out.push(new ExternalHyperlink({ link: l.href, children: [new TextRun({ text: unescape(l.text), style: 'Hyperlink' })] }))
        break
      }
      case 'image':
        out.push(run(t('[图片：{{v0}}]', { v0: (tok as Tokens.Image).text || (tok as Tokens.Image).href }), style))
        break
      case 'text': {
        const x = tok as Tokens.Text
        if (x.tokens?.length) out.push(...inline(x.tokens, style))
        else out.push(run(x.text, style))
        break
      }
      default:
        if ('text' in tok && typeof tok.text === 'string') out.push(run(tok.text, style))
    }
  }
  return out
}

type Block = Paragraph | Table

function blocks(tokens: Token[], ctx: { list: number }, depth = 0): Block[] {
  const out: Block[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading': {
        const h = tok as Tokens.Heading
        out.push(new Paragraph({ heading: HEADINGS[Math.min(h.depth, 6) - 1], children: inline(h.tokens) }))
        break
      }
      case 'paragraph':
        out.push(new Paragraph({ children: inline((tok as Tokens.Paragraph).tokens), spacing: { after: 120 } }))
        break
      case 'list': {
        const l = tok as Tokens.List
        const instance = ++ctx.list
        for (const item of l.items) {
          const [first, ...rest] = item.tokens
          const lead = first && (first.type === 'text' || first.type === 'paragraph') ? inline((first as Tokens.Text).tokens ?? [first]) : []
          const marker = item.task ? `${item.checked ? '☑' : '☐'} ` : ''
          out.push(
            new Paragraph({
              children: [...(marker ? [new TextRun(marker)] : []), ...lead],
              ...(l.ordered ? { numbering: { reference: 'ordered', level: Math.min(depth, 8), instance } } : { bullet: { level: Math.min(depth, 8) } }),
            }),
          )
          out.push(...blocks(lead.length ? rest : item.tokens, ctx, depth + 1))
        }
        break
      }
      case 'code':
        for (const line of (tok as Tokens.Code).text.split('\n'))
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || ' ', font: MONO, size: 19 })],
              shading: { type: ShadingType.CLEAR, fill: 'F6F7F9', color: 'auto' },
              spacing: { after: 0 },
            }),
          )
        out.push(new Paragraph({ children: [] }))
        break
      case 'blockquote':
        out.push(...blocks((tok as Tokens.Blockquote).tokens, ctx, depth))
        break
      case 'table': {
        const tb = tok as Tokens.Table
        const cell = (c: Tokens.TableCell, header: boolean) =>
          new TableCell({
            children: [
              new Paragraph({
                children: inline(c.tokens, header ? { bold: true } : {}),
                alignment: c.align === 'right' ? AlignmentType.RIGHT : c.align === 'center' ? AlignmentType.CENTER : undefined,
              }),
            ],
            shading: header ? { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } : undefined,
          })
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: tb.header.map((c) => cell(c, true)) }),
              ...tb.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
            ],
          }),
        )
        out.push(new Paragraph({ children: [] }))
        break
      }
      case 'hr':
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D3D9', space: 1 } } }))
        break
      case 'html':
        if ((tok as Tokens.HTML).text.trim()) out.push(new Paragraph({ children: [new TextRun((tok as Tokens.HTML).text.replace(/<[^>]+>/g, '').trim())] }))
        break
      case 'space':
        break
      default:
        if ('text' in tok && typeof tok.text === 'string' && tok.text.trim()) out.push(new Paragraph({ children: [new TextRun(unescape(tok.text))] }))
    }
  }
  return out
}

export async function markdownToDocx(md: string, title: string): Promise<Buffer> {
  const doc = new Document({
    title,
    creator: 'Navo',
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: blocks(marked.lexer(md, { gfm: true }), { list: 0 }) }],
  })
  return Packer.toBuffer(doc)
}
