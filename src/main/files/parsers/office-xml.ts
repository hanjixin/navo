import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { markdownTable, normalizeCjk, tidyMarkdown } from '../text-utils'

type Node = Record<string, unknown>

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', preserveOrder: true, trimValues: false })

const tag = (n: Node) => Object.keys(n).find((k) => k !== ':@') ?? ''
const kids = (n: Node): Node[] => {
  const v = n[tag(n)]
  return Array.isArray(v) ? (v as Node[]) : []
}
const attr = (n: Node, a: string) => ((n[':@'] as Record<string, string> | undefined) ?? {})[`@${a}`]

function textOf(nodes: Node[], textTag: string): string {
  let out = ''
  for (const n of nodes) {
    const t = tag(n)
    if (t === '#text') out += String(n['#text'])
    else if (t === textTag)
      out += kids(n)
        .map((k) => String(k['#text'] ?? ''))
        .join('')
    else if (t === 'a:br' || t === 'text:line-break') out += '\n'
    else if (t === 'text:tab' || t === 'a:tab') out += '\t'
    else if (t === 'text:s') out += ' '
    else out += textOf(kids(n), textTag)
  }
  return out
}

function findAll(nodes: Node[], name: string, out: Node[] = []): Node[] {
  for (const n of nodes) {
    if (tag(n) === name) out.push(n)
    else findAll(kids(n), name, out)
  }
  return out
}

const slideNo = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0)

/** PowerPoint (.pptx): slides in order, title as heading, bullet levels, tables, speaker notes. */
export async function parsePptx(buf: Buffer): Promise<{ markdown: string; slides: number }> {
  const zip = await JSZip.loadAsync(buf)
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNo(a) - slideNo(b))
  const parts: string[] = []
  for (const [i, path] of slides.entries()) {
    const doc = xml.parse(await zip.file(path)!.async('string')) as Node[]
    let title = ''
    const body: string[] = []
    for (const sp of findAll(doc, 'p:sp')) {
      const ph = findAll(kids(sp), 'p:ph')[0]
      const type = ph ? attr(ph, 'type') : undefined
      const paras = findAll(kids(sp), 'a:p')
      const lines = paras
        .map((p) => {
          const lvl = Number(attr(findAll(kids(p), 'a:pPr')[0] ?? {}, 'lvl') ?? 0)
          return { lvl, text: normalizeCjk(textOf(kids(p), 'a:t')).trim() }
        })
        .filter((l) => l.text)
      if (!lines.length) continue
      if ((type === 'title' || type === 'ctrTitle') && !title) {
        title = lines.map((l) => l.text).join(' ')
        continue
      }
      const bulleted = lines.length > 1 || type === 'body'
      body.push(lines.map((l) => (bulleted ? `${'  '.repeat(l.lvl)}- ${l.text}` : l.text)).join('\n'))
    }
    for (const tbl of findAll(doc, 'a:tbl')) {
      const rows = findAll(kids(tbl), 'a:tr').map((tr) => findAll(kids(tr), 'a:tc').map((tc) => normalizeCjk(textOf(kids(tc), 'a:t')).trim()))
      if (rows.length) body.push(markdownTable(rows))
    }
    parts.push(`## 第 ${i + 1} 张${title ? `：${title}` : ''}`)
    if (body.length) parts.push(body.join('\n\n'))
    const notesPath = `ppt/notesSlides/notesSlide${slideNo(path)}.xml`
    if (zip.file(notesPath)) {
      const notesDoc = xml.parse(await zip.file(notesPath)!.async('string')) as Node[]
      const notes = findAll(notesDoc, 'p:sp')
        .filter((sp) => attr(findAll(kids(sp), 'p:ph')[0] ?? {}, 'type') === 'body')
        .flatMap((sp) => findAll(kids(sp), 'a:p').map((p) => normalizeCjk(textOf(kids(p), 'a:t')).trim()))
        .filter(Boolean)
      if (notes.length) parts.push(`> 备注：${notes.join(' ')}`)
    }
  }
  return { markdown: tidyMarkdown(parts.join('\n\n')), slides: slides.length }
}

/** OpenDocument text / presentation (.odt, .odp): headings, paragraphs, lists, tables from content.xml. */
export async function parseOdf(buf: Buffer, ext: 'odt' | 'odp'): Promise<{ markdown: string; units?: number }> {
  const zip = await JSZip.loadAsync(buf)
  const doc = xml.parse(await zip.file('content.xml')!.async('string')) as Node[]
  const out: string[] = []
  let pages = 0
  const walk = (nodes: Node[], listDepth = -1) => {
    for (const n of nodes) {
      const t = tag(n)
      if (t === 'text:h') out.push(`${'#'.repeat(Math.min(6, Number(attr(n, 'text:outline-level') ?? 1)))} ${normalizeCjk(textOf(kids(n), '')).trim()}`)
      else if (t === 'text:p') {
        const s = normalizeCjk(textOf(kids(n), '')).trim()
        if (s) out.push(listDepth >= 0 ? `${'  '.repeat(listDepth)}- ${s}` : s)
      } else if (t === 'text:list') walk(kids(n), listDepth + 1)
      else if (t === 'table:table') {
        const rows = findAll(kids(n), 'table:table-row').map((r) => findAll(kids(r), 'table:table-cell').map((c) => normalizeCjk(textOf(kids(c), '')).trim()))
        if (rows.length) out.push(markdownTable(rows))
      } else if (t === 'draw:page') {
        pages++
        out.push(`## 第 ${pages} 张${attr(n, 'draw:name') && !/^page\d+$/i.test(attr(n, 'draw:name')!) ? `：${attr(n, 'draw:name')}` : ''}`)
        walk(kids(n), listDepth)
      } else walk(kids(n), listDepth)
    }
  }
  walk(doc)
  return { markdown: tidyMarkdown(out.join('\n\n').replace(/^(\s*- .+)\n\n(?=\s*- )/gm, '$1\n')), units: ext === 'odp' ? pages : undefined }
}
