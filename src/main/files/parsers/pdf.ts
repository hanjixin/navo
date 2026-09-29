import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { realProcessType } from '../pdfjs-env'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { ocrImage } from '../ocr'
import { MAX_PAGE_VISUALS, writeVisual } from '../visuals'
import { isCjk, joinWords, markdownTable, normalizeCjk, tidyMarkdown } from '../text-utils'
import type { ParseOptions, ParseResult } from '../types'

// Run pdf.js "in-process": bundling breaks its dynamic worker import, so hand it the worker module directly.
;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker
if (realProcessType) Object.defineProperty(process, 'type', { value: realProcessType, configurable: true, writable: true })

interface Glyph {
  str: string
  x: number
  y: number
  w: number
  size: number
}

interface Line {
  y: number
  size: number
  glyphs: Glyph[]
  text: string
  /** cells when the line has wide gaps (table candidate) */
  cells: { x: number; text: string }[]
  /** cells split at smaller gaps: only trusted when several lines align exactly (narrow tables) */
  tight: { x: number; text: string }[]
  x: number
  /** right edge of the line */
  end: number
}

const MIN_TEXT_CHARS = 25 // below this a page is treated as scanned
/** Tesseract works best around 300 DPI; cap the bitmap size for very large pages. */
const OCR_DPI = 300
const OCR_MAX_PX = 4000

function toLines(glyphs: Glyph[]): Line[] {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Glyph[][] = []
  for (const g of sorted) {
    const cur = lines[lines.length - 1]
    if (cur && Math.abs(cur[0].y - g.y) < Math.max(cur[0].size, g.size) * 0.5) cur.push(g)
    else lines.push([g])
  }
  return lines.map((gs) => {
    gs.sort((a, b) => a.x - b.x)
    const size = Math.max(...gs.map((g) => g.size))
    let text = ''
    const cells: { x: number; text: string }[] = []
    let cell = { x: gs[0].x, text: '' }
    const tight: { x: number; text: string }[] = []
    let tcell = { x: gs[0].x, text: '' }
    let prevEnd = gs[0].x
    for (const g of gs) {
      const gap = g.x - prevEnd
      if (gap > size * 0.9 && cell.text.trim()) {
        cells.push(cell)
        cell = { x: g.x, text: '' }
      }
      if (gap > size * 0.4 && tcell.text.trim()) {
        tight.push(tcell)
        tcell = { x: g.x, text: '' }
      }
      const glue = gap > size * 0.2 && !(isCjk(text.slice(-1)) && isCjk(g.str[0])) ? ' ' : ''
      text = text ? text + glue + g.str : g.str
      cell.text = cell.text ? cell.text + glue + g.str : g.str
      tcell.text = tcell.text ? tcell.text + glue + g.str : g.str
      prevEnd = Math.max(prevEnd, g.x + g.w)
    }
    if (cell.text.trim()) cells.push(cell)
    if (tcell.text.trim()) tight.push(tcell)
    const last = gs[gs.length - 1]
    return {
      y: gs[0].y,
      size,
      glyphs: gs,
      text: text.replace(/\s+/g, ' ').trim(),
      cells: cells.map((c) => ({ x: c.x, text: c.text.trim() })),
      tight: tight.map((c) => ({ x: c.x, text: c.text.trim() })),
      x: gs[0].x,
      end: last.x + last.w,
    }
  })
}

const BULLET = /^([•·●○◦▪■□◆◇\-–—*]|\d{1,2}[.)、]|[（(]\d{1,2}[)）]|[a-zA-Z][.)])\s*/

/** Consecutive lines with ≥2 aligned cells become a Markdown table. */
function tableRuns(lines: Line[]): Map<number, number> {
  const runs = new Map<number, number>() // start index → end index (exclusive)
  let i = 0
  while (i < lines.length) {
    const n = lines[i].cells.length
    if (n < 2) {
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && lines[j].cells.length >= 2 && Math.abs(lines[j].cells.length - n) <= 1 && aligned(lines[i], lines[j])) j++
    if (j - i >= 2) {
      // header / footer rows are often packed tighter than the body: pull in neighbours whose
      // small-gap cells line up with the table's columns
      const ref = lines[i].tight.length > lines[i].cells.length ? lines[i].tight : lines[i].cells
      const fits = (l: Line | undefined) => {
        if (!l || l.cells.length >= 2) return false
        // pdf.js merges closely spaced runs into one item ("Region Sales Growth"), so fall back to words
        const cand = l.tight.length === ref.length ? l.tight : wordCells(l)
        if (cand.length !== ref.length || !cand.every((c, k) => Math.abs(c.x - ref[k].x) < l.size * 1.5)) return false
        l.tight = cand
        return true
      }
      let start = i
      while (start > 0 && !runs.has(start - 1) && fits(lines[start - 1])) start--
      while (j < lines.length && fits(lines[j])) j++
      runs.set(start, j)
    }
    i = Math.max(j, i + 1)
  }
  return runs
}

/**
 * Word cells with x estimated inside each text item. pdf.js merges closely spaced runs into one
 * item ("地区 收入"), so glyph widths are approximated (CJK ≈ 1em, Latin ≈ 0.55em) and the leftover
 * width is attributed to the spaces.
 */
function wordCells(l: Line): { x: number; text: string }[] {
  const out: { x: number; text: string }[] = []
  let prevEnd = -Infinity
  for (const g of l.glyphs) {
    const chars = [...g.str]
    // a run that continues the previous one without a gap continues its last word ("收" + "入")
    const joined = g.x - prevEnd < g.size * 0.2 && !/^\s/.test(g.str) && out.length > 0
    prevEnd = g.x + g.w
    const em = (c: string) => (isCjk(c) || /[\uff00-\uffef\u3000-\u303f]/.test(c) ? 1 : /[A-Z]/.test(c) ? 0.65 : 0.55)
    const spaces = chars.filter((c) => /\s/.test(c)).length
    const ink = chars.reduce((a, c) => a + (/\s/.test(c) ? 0 : em(c) * g.size), 0)
    const scale = spaces && g.w > ink ? 1 : g.w / Math.max(ink, 1)
    const space = spaces && g.w > ink ? (g.w - ink) / spaces : 0
    let x = g.x
    let word: { x: number; text: string } | null = joined ? out.pop()! : null
    for (const c of chars) {
      if (/\s/.test(c)) {
        if (word) out.push(word)
        word = null
        x += space
        continue
      }
      word ??= { x, text: '' }
      word.text += c
      x += em(c) * g.size * scale
    }
    if (word) out.push(word)
  }
  return out
}

/**
 * Tables whose columns sit so close that pdf.js merged each row into one item: ≥3 short rows with
 * the same word count and aligned words. Guards against lists ("Step 1 / Step 2") and prose.
 */
function wordRuns(lines: Line[], taken: Map<number, number>): Map<number, number> {
  const runs = new Map<number, number>()
  const covered = (i: number) => [...taken].some(([a, b]) => i >= a && i < b)
  const words = lines.map((l) => (l.cells.length < 2 && !/[。.!?！？,，:：;；]$/.test(l.text) ? wordCells(l) : []))
  const ok = (w: { text: string }[]) => w.length >= 2 && w.length <= 8 && w.every((c) => c.text.length <= 20)
  let i = 0
  while (i < lines.length) {
    if (covered(i) || !ok(words[i])) {
      i++
      continue
    }
    const tol = lines[i].size
    let j = i + 1
    while (j < lines.length && !covered(j) && words[j].length === words[i].length && words[j].every((c, k) => Math.abs(c.x - words[i][k].x) < tol)) j++
    const rows = words.slice(i, j)
    const distinct = rows[0].every((_, k) => new Set(rows.map((r) => r[k].text)).size > 1)
    if (j - i >= 3 && distinct) {
      for (let k = i; k < j; k++) lines[k].tight = words[k]
      runs.set(i, j)
    }
    i = Math.max(j, i + 1)
  }
  return runs
}

function aligned(a: Line, b: Line): boolean {
  const tol = Math.max(a.size, b.size) * 2.5
  const hits = a.cells.filter((c) => b.cells.some((d) => Math.abs(c.x - d.x) < tol)).length
  return hits >= Math.min(a.cells.length, b.cells.length) - 1 && hits >= 1
}

/** Narrow tables: ≥3 consecutive lines with the same number of tight cells starting at the same x. */
function tightRuns(lines: Line[], taken: Map<number, number>): Map<number, number> {
  const runs = new Map<number, number>()
  const covered = (i: number) => [...taken].some(([a, b]) => i >= a && i < b)
  let i = 0
  while (i < lines.length) {
    const n = lines[i].tight.length
    if (n < 2 || covered(i)) {
      i++
      continue
    }
    const tol = lines[i].size * 0.5
    let j = i + 1
    while (
      j < lines.length &&
      !covered(j) &&
      lines[j].tight.length === n &&
      lines[j].tight.every((c, k) => Math.abs(c.x - lines[i].tight[k].x) < tol || (k === 0 && Math.abs(c.x - lines[i].tight[0].x) < tol))
    )
      j++
    if (j - i >= 3) runs.set(i, j)
    i = Math.max(j, i + 1)
  }
  return runs
}

function tableFrom(lines: Line[]): string {
  // column anchors from the widest row
  const useTight = lines.every((l) => l.cells.length < 2 || l.tight.length > l.cells.length) && lines.every((l) => l.tight.length === lines[0].tight.length)
  const cellsOf = (l: Line) => (useTight ? l.tight : l.cells)
  const anchors = cellsOf([...lines].sort((a, b) => cellsOf(b).length - cellsOf(a).length)[0]).map((c) => c.x)
  const rows = lines.map((l) => {
    const row: string[] = anchors.map(() => '')
    // per row: wide cells when they match the column count, otherwise the tighter split
    const own = useTight ? l.tight : l.cells.length >= anchors.length ? l.cells : l.tight.length === anchors.length ? l.tight : l.cells
    for (const c of own) {
      let best = 0
      for (let k = 1; k < anchors.length; k++) if (Math.abs(anchors[k] - c.x) < Math.abs(anchors[best] - c.x)) best = k
      row[best] = row[best] ? `${row[best]} ${c.text}` : c.text
    }
    return row
  })
  return markdownTable(rows)
}

/** Median glyph size weighted by text length = body text size. */
function bodySize(pages: Line[][]): number {
  const sizes: number[] = []
  for (const lines of pages)
    for (const l of lines) for (const g of l.glyphs) for (let k = 0; k < Math.min(g.str.length, 50); k++) sizes.push(Math.round(g.size * 2) / 2)
  sizes.sort((a, b) => a - b)
  return sizes[Math.floor(sizes.length / 2)] || 10
}

/** Lines that repeat inside the top/bottom margin band of most pages (running headers, footers). */
function boilerplate(pages: Line[][], heights: number[]): Set<string> {
  // exact repeats only: normalising digits would also match real headings like "Chapter 1/2/3";
  // page numbers are handled separately by pattern
  const counts = new Map<string, number>()
  pages.forEach((lines, i) => {
    const h = heights[i] || 842
    const edge = lines.filter((l) => l.y > h * 0.92 || l.y < h * 0.08)
    for (const l of new Set(edge.map((x) => x.text))) counts.set(l, (counts.get(l) ?? 0) + 1)
  })
  const out = new Set<string>()
  if (pages.length < 3) return out
  for (const [k, n] of counts) if (n >= Math.max(3, pages.length * 0.5)) out.add(k)
  return out
}

/** Most common left edge of body lines = the text column's left margin. */
function leftMargin(lines: Line[]): number {
  const counts = new Map<number, number>()
  for (const l of lines) counts.set(Math.round(l.x), (counts.get(Math.round(l.x)) ?? 0) + l.text.length)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
}

function renderPage(lines: Line[], body: number, skip: Set<string>): string {
  const out: string[] = []
  const wide = tableRuns(lines)
  const narrow = new Map([...wide, ...tightRuns(lines, wide)])
  const tables = new Map([...narrow, ...wordRuns(lines, narrow)])
  const margin = leftMargin(lines)
  const right = Math.max(...lines.map((l) => l.end), 0)
  let para = ''
  let prev: Line | null = null
  const flush = () => {
    if (para.trim()) out.push(para.trim())
    para = ''
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (skip.has(l.text) || /^[-–—\s]*\d+[-–—\s]*$|^第\s*\d+\s*页|^page\s+\d+(\s+of\s+\d+)?$/i.test(l.text)) continue
    const end = tables.get(i)
    if (end) {
      flush()
      out.push(tableFrom(lines.slice(i, end)))
      i = end - 1
      prev = null
      continue
    }
    const ratio = l.size / body
    if (ratio >= 1.2 && l.text.length < 120) {
      flush()
      out.push(`${'#'.repeat(ratio >= 1.8 ? 1 : ratio >= 1.4 ? 2 : 3)} ${l.text}`)
      prev = l
      continue
    }
    // explicit bullet glyphs, or an indented short line (bullets drawn as vector graphics leave only the indent)
    const indented = l.x > margin + l.size * 1.2 && l.end < right - l.size * 2
    const nextIndented = lines[i + 1] && Math.abs(lines[i + 1].x - l.x) < l.size * 0.5
    const prevIndented = prev && Math.abs(prev.x - l.x) < l.size * 0.5 && prev.x > margin + l.size * 1.2
    if (BULLET.test(l.text) || (indented && (nextIndented || prevIndented))) {
      flush()
      para = `- ${l.text.replace(BULLET, '')}`
      out.push(para)
      para = ''
      prev = l
      continue
    }
    // same paragraph when the vertical gap is small and the indentation matches
    const gap = prev ? prev.y - l.y : Infinity
    // a line only wraps into the next when it ran (nearly) to the right edge
    const prevFull = prev ? prev.end > right - prev.size * 2.5 : false
    const sameBlock = prev && prevFull && gap < l.size * 1.9 && Math.abs(prev.size - l.size) < 0.6
    if (sameBlock && para) para = para.endsWith('-') && /[a-z]$/i.test(para.slice(-2, -1)) ? para.slice(0, -1) + l.text : joinWords(para, l.text)
    else {
      flush()
      para = l.text
    }
    prev = l
  }
  flush()
  return out.join('\n\n')
}

export async function parsePdf(buf: Buffer, opts: ParseOptions): Promise<ParseResult> {
  const warnings: string[] = []
  const base = pathToFileURL(opts.pdfAssetsDir).href.replace(/\/?$/, '/')
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    useSystemFonts: false,
    verbosity: 0,
  })
  const doc = await task.promise
  const meta = await doc.getMetadata().catch(() => null)
  const rawTitle = ((meta?.info as { Title?: string } | undefined)?.Title || '').trim()
  // printers often put the source URL / file name here; only keep a real title
  const title = rawTitle && rawTitle.length < 150 && !/^(data:|https?:|file:)|\.(docx?|pdf|pptx?)$/i.test(rawTitle) ? normalizeCjk(rawTitle) : undefined

  const pages: Line[][] = []
  const heights: number[] = []
  const needsOcr: number[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    opts.onProgress?.(`正在读取第 ${p}/${doc.numPages} 页`)
    const page = await doc.getPage(p)
    heights.push(page.getViewport({ scale: 1 }).height)
    const content = await page.getTextContent()
    const glyphs: Glyph[] = []
    for (const it of content.items as { str: string; transform: number[]; width: number; height: number }[]) {
      if (!it.str || !it.str.trim()) continue
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10
      glyphs.push({ str: normalizeCjk(it.str), x: it.transform[4], y: it.transform[5], w: it.width, size })
    }
    const chars = glyphs.reduce((n, g) => n + g.str.trim().length, 0)
    pages.push(toLines(glyphs))
    if (chars < MIN_TEXT_CHARS) needsOcr.push(p)
    page.cleanup()
  }

  const ocrText = new Map<number, string>()
  const ocr = opts.ocr !== false
  let visuals = 0
  if (needsOcr.length && (ocr || opts.visualsDir)) {
    for (const p of needsOcr) {
      // without OCR the page is still rendered once, so vision models can read it
      if (!ocr && visuals >= MAX_PAGE_VISUALS) break
      opts.onProgress?.(ocr ? `第 ${p} 页没有文字层，正在 OCR 识别…` : `正在渲染扫描页 ${p}…`)
      try {
        const page = await doc.getPage(p)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(OCR_DPI / 72, OCR_MAX_PX / Math.max(base.width, base.height))
        const viewport = page.getViewport({ scale })
        const factory = (
          doc as unknown as { canvasFactory: { create: (w: number, h: number) => { canvas: { toBuffer: (t: string) => Buffer }; context: unknown } } }
        ).canvasFactory
        const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({ canvasContext: context as never, viewport, canvas: canvas as never }).promise
        const png = canvas.toBuffer('image/png')
        if (opts.visualsDir && visuals < MAX_PAGE_VISUALS && (await writeVisual(png, opts.visualsDir, `page-${p}`, visuals === 0))) visuals++
        if (!ocr) continue
        const { text, confidence } = await ocrImage(png, opts)
        ocrText.set(p, text)
        if (confidence < 60) warnings.push(`第 ${p} 页为扫描件，OCR 置信度较低（${Math.round(confidence)}%），请核对`)
      } catch (err) {
        warnings.push(`第 ${p} 页 OCR 失败：${(err as Error).message}`)
      }
    }
  }
  if (needsOcr.length && !ocr) warnings.push(`${needsOcr.length} 页没有文字层（可能是扫描件），未执行 OCR`)

  const body = bodySize(pages.filter((_, i) => !ocrText.has(i + 1)))
  const skip = boilerplate(pages, heights)
  const parts: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const p = i + 1
    const content = ocrText.has(p) ? ocrText.get(p)! : renderPage(pages[i], body, skip)
    if (doc.numPages > 1) parts.push(`<!-- 第 ${p} 页 -->`)
    parts.push(content || '_（本页无文字内容）_')
  }
  await task.destroy()
  return {
    markdown: tidyMarkdown(parts.join('\n\n')),
    kind: 'pdf',
    title,
    units: pages.length,
    unitLabel: '页',
    ocrPages: [...ocrText.keys()],
    warnings,
    engine: 'builtin',
  }
}

export const pdfAssetsFromNodeModules = (root: string) => join(root, 'node_modules', 'pdfjs-dist')
