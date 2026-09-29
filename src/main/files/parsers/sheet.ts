import * as XLSX from 'xlsx'
import { markdownTable, normalizeCjk } from '../text-utils'

const MAX_ROWS_PER_SHEET = 500
const MAX_COLS = 60

/**
 * Spreadsheets (xlsx, xlsm, xls, ods, csv, tsv) → one Markdown table per sheet, using the displayed
 * (formatted) cell values so dates, currency and percentages read as they do in Excel.
 */
export function parseSheet(input: Buffer | string, ext: string): { markdown: string; sheets: number; warnings: string[] } {
  // text formats arrive already decoded (GBK etc. handled by decodeText)
  const wb =
    typeof input === 'string'
      ? XLSX.read(input, { type: 'string', raw: false, FS: ext === 'tsv' ? '\t' : undefined })
      : XLSX.read(input, { type: 'buffer', cellDates: true, dense: true })
  const parts: string[] = []
  const warnings: string[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false }) as unknown[][]).map((r) =>
      r.slice(0, MAX_COLS).map((v) => normalizeCjk(String(v ?? '')).trim()),
    )
    // drop trailing empty columns
    const width = rows.reduce((w, r) => Math.max(w, r.reduceRight((last, v, i) => (last === -1 && v ? i : last), -1) + 1), 0)
    const trimmed = rows.map((r) => r.slice(0, width)).filter((r) => r.some(Boolean))
    if (wb.SheetNames.length > 1 || !['csv', 'tsv'].includes(ext)) parts.push(`## ${name}`)
    if (!trimmed.length) {
      parts.push('_（空工作表）_')
      continue
    }
    const shown = trimmed.slice(0, MAX_ROWS_PER_SHEET + 1)
    parts.push(markdownTable(shown))
    if (trimmed.length > shown.length) {
      parts.push(`_（共 ${trimmed.length - 1} 行数据，此处显示前 ${MAX_ROWS_PER_SHEET} 行）_`)
      warnings.push(`工作表「${name}」有 ${trimmed.length - 1} 行，Markdown 中只保留了前 ${MAX_ROWS_PER_SHEET} 行`)
    }
    if (rows.some((r) => r.length >= MAX_COLS)) warnings.push(`工作表「${name}」超过 ${MAX_COLS} 列，已截断`)
  }
  return { markdown: parts.join('\n\n'), sheets: wb.SheetNames.length, warnings }
}
