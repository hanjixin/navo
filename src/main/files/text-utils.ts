import chardet from 'chardet'
import iconv from 'iconv-lite'

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

export const isCjk = (ch: string | undefined) => !!ch && CJK.test(ch)

/** Joins two fragments with a space unless either side is CJK (Chinese text has no spaces between words). */
export function joinWords(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const last = a[a.length - 1]
  const first = b[0]
  if (isCjk(last) || isCjk(first) || /\s$/.test(a) || /^\s/.test(b)) return a + b
  return `${a} ${b}`
}

/** Removes the spaces OCR engines put between CJK characters ("季 度 报 告" → "季度报告"). */
export function tidyCjkSpacing(s: string): string {
  const C = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef'
  return (
    s
      .replace(new RegExp(`([${C}]) +(?=[${C}])`, 'g'), '$1')
      // no spaces between Chinese text and adjacent ASCII punctuation: "测试 : 合同" → "测试:合同"
      .replace(new RegExp(`([${C}]) +(?=[:;,.!?)\\]])`, 'g'), '$1')
      .replace(new RegExp(`([:;,.!?(\\[]) +(?=[${C}])`, 'g'), '$1')
  )
}

/**
 * Decodes text files reliably: BOMs, strict UTF-8, then detection for legacy encodings such as
 * GBK/GB18030 (common for Chinese Windows files), Big5, Shift_JIS, UTF-16 without BOM.
 */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: iconv.decode(buf.subarray(2), 'utf16le'), encoding: 'UTF-16LE' }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: iconv.decode(buf.subarray(2), 'utf16be'), encoding: 'UTF-16BE' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' }
  } catch {
    /* not valid UTF-8 */
  }
  const guess = chardet.detect(buf.subarray(0, 64 * 1024)) ?? 'GB18030'
  // GB2312/GBK are subsets of GB18030; decoding with the superset avoids losing rare characters
  const enc = /^(GB2312|GBK|GB18030|x-gbk)$/i.test(guess) ? 'GB18030' : iconv.encodingExists(guess) ? guess : 'GB18030'
  return { text: iconv.decode(buf, enc), encoding: enc }
}

/** Heuristic: binary files contain NUL bytes early on. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim()
}

/** Renders rows as a GitHub-flavoured Markdown table (first row = header). */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length))
  if (!rows.length || width === 0) return ''
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => escapeCell(r[i] ?? '')))
  const [head, ...body] = norm
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** Collapses excessive blank lines and trailing spaces. */
export function tidyMarkdown(md: string): string {
  return (
    md
      .replace(/\r\n?/g, '\n')
      // "-   item" (turndown) → "- item"
      .replace(/^(\s*)([-*+]|\d+\.)[ \t]{2,}(?=\S)/gm, '$1$2 ')
      // keep consecutive list items together (tight list)
      .replace(/^(- .+)\n\n(?=- )/gm, '$1\n')
      .replace(/^(- .+)\n\n(?=- )/gm, '$1\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * CJK Radicals Supplement code points that PDF fonts often emit instead of the real character
 * (NFKC doesn't map these). Kangxi Radicals (U+2F00–U+2FD5) are handled by NFKC itself.
 */
const RADICAL_SUPPLEMENT: Record<string, string> = {
  '⺁': '厂',
  '⺇': '几',
  '⺌': '小',
  '⺍': '小',
  '⺕': '彐',
  '⺟': '母',
  '⺠': '民',
  '⺢': '水',
  '⺣': '火',
  '⺮': '竹',
  '⺶': '羊',
  '⺷': '羊',
  '⺻': '聿',
  '⻂': '衣',
  '⻃': '西',
  '⻄': '西',
  '⻅': '见',
  '⻆': '角',
  '⻈': '讠',
  '⻉': '贝',
  '⻋': '车',
  '⻌': '辶',
  '⻍': '辶',
  '⻏': '阝',
  '⻑': '长',
  '⻒': '长',
  '⻓': '长',
  '⻔': '门',
  '⻘': '青',
  '⻙': '韦',
  '⻚': '页',
  '⻛': '风',
  '⻜': '飞',
  '⻝': '食',
  '⻠': '饣',
  '⻢': '马',
  '⻣': '骨',
  '⻤': '鬼',
  '⻥': '鱼',
  '⻦': '鸟',
  '⻧': '卤',
  '⻨': '麦',
  '⻩': '黄',
  '⻬': '齐',
  '⻮': '齿',
  '⻯': '龙',
  '⻰': '龙',
  '⻳': '龟',
  '⻭': '齿',
  '⻪': '黾',
}

/** Replaces radical look-alikes with the characters they stand for, so text stays searchable and readable. */
export function normalizeCjk(s: string): string {
  // NFKC only on Kangxi radicals and compatibility ideographs: applying it to the whole string
  // would also turn full-width Chinese punctuation （，：） into ASCII
  return s.replace(/[\u2f00-\u2fdf\uf900-\ufaff]/g, (ch) => ch.normalize('NFKC')).replace(/[\u2e80-\u2eff]/g, (ch) => RADICAL_SUPPLEMENT[ch] ?? ch)
}
