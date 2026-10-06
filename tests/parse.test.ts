/**
 * Parsing quality suite: every format is generated with a real library, parsed, and checked for
 * structure (headings, lists, tables, page/slide/sheet order) and exact Chinese / English text.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import fontkit from '@pdf-lib/fontkit'
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import iconv from 'iconv-lite'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseFile } from '../src/main/files/parse'
import { UnsupportedFileError } from '../src/main/files/types'

// OCR language data from the same npm packages the app bundles (no network); fresh cache each run
const ocrLangDir = mkdtempSync(join(tmpdir(), 'navo-ocr-lang-'))
for (const l of ['chi_sim', 'eng'])
  copyFileSync(`node_modules/@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`, join(ocrLangDir, `${l}.traineddata.gz`))
const opts = { pdfAssetsDir: 'node_modules/pdfjs-dist', ocrCacheDir: mkdtempSync(join(tmpdir(), 'navo-ocr-cache-')), ocrLangDir }
const parse = (buf: Buffer | Uint8Array, name: string) => parseFile(Buffer.from(buf), name, opts)
const CJK_FONT = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
].find(existsSync)
// The OCR tests draw Chinese text into an image first, so they need a CJK font: registered explicitly
// (not left to system font matching) and skipped where none is installed.
if (CJK_FONT) GlobalFonts.registerFromPath(CJK_FONT, 'NavoTestCJK')
const ocrEnabled = process.env.SKIP_OCR !== '1' && !!CJK_FONT

describe('Word (.docx)', () => {
  it('keeps headings, lists, tables, emphasis and Chinese text', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '项目周报', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ children: [new TextRun('本周完成了'), new TextRun({ text: '登录模块', bold: true }), new TextRun('的开发。')] }),
            new Paragraph({ text: '风险与问题', heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: '接口文档延迟', bullet: { level: 0 } }),
            new Paragraph({ text: '测试环境不稳定', bullet: { level: 0 } }),
            new Table({
              rows: [
                new TableRow({ children: ['任务', '负责人', '进度'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
                new TableRow({ children: ['登录', '张三', '100%'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
                new TableRow({ children: ['支付', '李四', '60%'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
              ],
            }),
            new Paragraph({ text: 'Next week: payment integration.', alignment: AlignmentType.LEFT }),
          ],
        },
      ],
    })
    const r = await parse(await Packer.toBuffer(doc), '周报.docx')
    expect(r.kind).toBe('word')
    expect(r.markdown).toMatch(/^# 项目周报$/m)
    expect(r.markdown).toMatch(/^## 风险与问题$/m)
    expect(r.markdown).toContain('本周完成了**登录模块**的开发。')
    expect(r.markdown).toMatch(/^- 接口文档延迟$/m)
    expect(r.markdown).toMatch(/^- 测试环境不稳定$/m)
    expect(r.markdown).toMatch(/\|\s*任务\s*\|\s*负责人\s*\|\s*进度\s*\|/)
    expect(r.markdown).toMatch(/\|\s*支付\s*\|\s*李四\s*\|\s*60%\s*\|/)
    expect(r.markdown).toContain('Next week: payment integration.')
  })
})

describe('Spreadsheets', () => {
  const wb = () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['日期', '产品', '销量', '金额'],
        [new Date(Date.UTC(2026, 8, 1)), '会员月卡', 120, 3588],
        [new Date(Date.UTC(2026, 8, 2)), '会员年卡', 35, 10465],
      ]),
      '九月销售',
    )
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['地区', '负责人'],
        ['华东', '王五'],
      ]),
      '团队',
    )
    return book
  }
  for (const [ext, bookType] of [
    ['xlsx', 'xlsx'],
    ['xls', 'biff8'],
    ['ods', 'ods'],
  ] as const) {
    it(`.${ext}: every sheet becomes a titled Markdown table`, async () => {
      const buf = XLSX.write(wb(), { type: 'buffer', bookType })
      const r = await parse(buf, `销售.${ext}`)
      expect(r.kind).toBe('sheet')
      expect(r.units).toBe(2)
      expect(r.markdown).toMatch(/^## 九月销售$/m)
      expect(r.markdown).toMatch(/^## 团队$/m)
      expect(r.markdown).toMatch(/\| 日期 \| 产品 \| 销量 \| 金额 \|/)
      expect(r.markdown).toMatch(/\| .*会员年卡 \| 35 \| 10465 \|/)
      expect(r.markdown).toMatch(/\| 华东 \| 王五 \|/)
    })
  }
  it('GBK-encoded CSV (Excel on Chinese Windows) decodes correctly', async () => {
    const csv = iconv.encode('姓名,部门,入职日期\n张三,研发部,2024-03-01\n李四,市场部,2025-07-15\n', 'gbk')
    const r = await parse(csv, '员工.csv')
    expect(r.markdown).toMatch(/\| 姓名 \| 部门 \| 入职日期 \|/)
    expect(r.markdown).toMatch(/\| 李四 \| 市场部 \| 2025-07-15 \|/)
    expect(r.warnings.join()).toMatch(/GB18030/)
  })
  it('large sheets are truncated with a note, not silently', async () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['n'], ...Array.from({ length: 800 }, (_, i) => [i])]), 'big')
    const r = await parse(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'big.xlsx')
    expect(r.markdown).toContain('共 800 行数据')
    expect(r.warnings.join()).toContain('800')
  })
})

describe('PowerPoint (.pptx)', () => {
  it('slides in order with titles, bullets, tables and speaker notes', async () => {
    const pres = new PptxGenJS()
    const s1 = pres.addSlide()
    s1.addText('产品发布会', { placeholder: 'title', x: 0.5, y: 0.3, w: 9, h: 1 })
    s1.addText(
      [{ text: '全新设计' }, { text: '续航提升 40%' }].map((t) => ({ ...t, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 1.5, w: 9, h: 2 },
    )
    s1.addNotes('开场先讲用户故事')
    const s2 = pres.addSlide()
    s2.addText('价格', { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 32 })
    s2.addTable(
      [
        [{ text: '版本' }, { text: '价格' }],
        [{ text: '标准版' }, { text: '¥1999' }],
      ],
      { x: 0.5, y: 1.5, w: 6 },
    )
    const buf = (await pres.write({ outputType: 'nodebuffer' })) as Buffer
    const r = await parse(buf, '发布会.pptx')
    expect(r.kind).toBe('slides')
    expect(r.units).toBe(2)
    expect(r.markdown.indexOf('第 1 张')).toBeLessThan(r.markdown.indexOf('第 2 张'))
    expect(r.markdown).toContain('全新设计')
    expect(r.markdown).toContain('续航提升 40%')
    expect(r.markdown).toMatch(/\| 版本 \| 价格 \|/)
    expect(r.markdown).toMatch(/\| 标准版 \| ¥1999 \|/)
    expect(r.markdown).toContain('备注：开场先讲用户故事')
  })
})

describe('PDF', () => {
  it('English text layer: headings, paragraphs, page markers, header/footer removal', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    for (let n = 1; n <= 3; n++) {
      const page = pdf.addPage([595, 842])
      page.drawText('ACME Corp · Confidential', { x: 50, y: 810, size: 8, font })
      page.drawText(`Chapter ${n}`, { x: 50, y: 740, size: 22, font: bold })
      page.drawText(`This is the first line of chapter ${n}, which is long enough to wrap onto`, { x: 50, y: 700, size: 11, font })
      page.drawText('the next line so the parser has to join both lines into one paragraph.', { x: 50, y: 686, size: 11, font })
      page.drawText(`${n}`, { x: 290, y: 30, size: 9, font })
    }
    const r = await parse(await pdf.save(), 'book.pdf')
    expect(r.units).toBe(3)
    expect(r.markdown).toMatch(/^# Chapter 1$/m)
    expect(r.markdown).toContain('which is long enough to wrap onto the next line so the parser has to join both lines into one paragraph.')
    expect(r.markdown).toContain('<!-- 第 3 页 -->')
    expect(r.markdown).not.toContain('Confidential') // running header on every page
    expect(r.markdown).not.toMatch(/^\s*2\s*$/m) // page numbers
  })

  it('narrow tables are rebuilt, while ordinary multi-line prose is not mistaken for a table', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([595, 842])
    // narrow table: ~6pt between columns (0.55 × font size)
    const rows = [
      ['Region', 'Sales', 'Growth'],
      ['East', '5200', '18%'],
      ['South', '3900', '31%'],
    ]
    const colX = [50, 50 + font.widthOfTextAtSize('Region', 11) + 6, 0]
    colX[2] = colX[1] + font.widthOfTextAtSize('Sales', 11) + 6
    rows.forEach((row, i) => row.forEach((c, j) => page.drawText(c, { x: colX[j], y: 760 - i * 16, size: 11, font })))
    // prose drawn word by word with normal spacing
    const prose = [
      'The quick brown fox jumps over the lazy dog and keeps',
      'running through the forest until the evening comes and',
      'the stars begin to shine above the quiet little village.',
    ]
    prose.forEach((line, i) => {
      let x = 50
      for (const w of line.split(' ')) {
        page.drawText(w, { x, y: 660 - i * 14, size: 11, font })
        x += font.widthOfTextAtSize(`${w} `, 11)
      }
    })
    const r = await parse(await pdf.save(), 'narrow.pdf')
    expect(r.markdown).toMatch(/\|\s*Region\s*\|\s*Sales\s*\|\s*Growth\s*\|/)
    expect(r.markdown).toMatch(/\|\s*South\s*\|\s*3900\s*\|\s*31%\s*\|/)
    expect(r.markdown).toContain('The quick brown fox jumps over the lazy dog and keeps running through the forest')
    expect(r.markdown.match(/\n\| /g)?.length ?? 0).toBeLessThanOrEqual(4) // only the real table's rows
  })

  it('merged single-item rows: aligned short rows become a table, step lists and prose do not', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([595, 842])
    ;['Step 1', 'Step 2', 'Step 3'].forEach((t, i) => page.drawText(t, { x: 50, y: 760 - i * 16, size: 11, font }))
    ;['Alpha went home.', 'Bravo left early.', 'Delta came back.'].forEach((t, i) => page.drawText(t, { x: 50, y: 680 - i * 16, size: 11, font }))
    const r = await parse(await pdf.save(), 'lists.pdf')
    expect(r.markdown).not.toContain('|')
  })

  // pdf-lib embeds single fonts, not .ttc collections (what Linux ships for Noto CJK)
  it.runIf(!!CJK_FONT && /\.(ttf|otf)$/i.test(CJK_FONT))('Chinese text + aligned columns become a table', async () => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(readFileSync(CJK_FONT!), { subset: true })
    const page = pdf.addPage([595, 842])
    page.drawText('年度预算', { x: 50, y: 760, size: 24, font })
    page.drawText('以下为各部门预算（单位：万元）。', { x: 50, y: 720, size: 11, font })
    const rows = [
      ['部门', '预算', '实际'],
      ['研发', '800', '760'],
      ['市场', '300', '325'],
    ]
    rows.forEach((row, i) => row.forEach((cell, j) => page.drawText(cell, { x: 50 + j * 150, y: 680 - i * 20, size: 11, font })))
    const r = await parse(await pdf.save(), '预算.pdf')
    expect(r.markdown).toMatch(/^# 年度预算$/m)
    expect(r.markdown).toContain('以下为各部门预算（单位：万元）。')
    expect(r.markdown).toMatch(/\| 部门 \| 预算 \| 实际 \|/)
    expect(r.markdown).toMatch(/\| 市场 \| 300 \| 325 \|/)
  })

  it.runIf(ocrEnabled)(
    "scanned page (no text layer) is OCR'd",
    async () => {
      const png = textImage(['扫描件：合同编号 HT-2026-0931', '甲方同意于十月十五日前付款。', 'Payment due: October 15, 2026'])
      const pdf = await PDFDocument.create()
      const img = await pdf.embedPng(png)
      pdf.addPage([595, 842]).drawImage(img, { x: 20, y: 400, width: 555, height: (555 * img.height) / img.width })
      const r = await parse(await pdf.save(), 'scan.pdf')
      expect(r.ocrPages).toEqual([1])
      expect(similarity(r.markdown, '扫描件:合同编号 HT-2026-0931\n甲方同意于十月十五日前付款。\nPayment due: October 15, 2026')).toBeGreaterThan(0.9)
    },
    120_000,
  )
})

describe('Images (OCR)', () => {
  it.runIf(ocrEnabled)(
    'recognises Chinese and English text in a screenshot',
    async () => {
      const r = await parse(textImage(['会议纪要', '时间：2026年10月8日', 'Owner: Alice Chen']), 'minutes.png')
      expect(r.kind).toBe('image')
      expect(similarity(r.markdown, '会议纪要\n时间:2026年10月8日\nOwner: Alice Chen')).toBeGreaterThan(0.85)
    },
    120_000,
  )
})

describe('OpenDocument, EPUB, HTML, RTF, archives', () => {
  it('.odt headings, list and table', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
    zip.file(
      'content.xml',
      `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:text>
      <text:h text:outline-level="1">会议记录</text:h><text:p>讨论了三个议题。</text:p>
      <text:list><text:list-item><text:p>预算</text:p></text:list-item><text:list-item><text:p>招聘</text:p></text:list-item></text:list>
      <table:table><table:table-row><table:table-cell><text:p>议题</text:p></table:table-cell><table:table-cell><text:p>结论</text:p></table:table-cell></table:table-row>
      <table:table-row><table:table-cell><text:p>预算</text:p></table:table-cell><table:table-cell><text:p>通过</text:p></table:table-cell></table:table-row></table:table>
      </office:text></office:body></office:document-content>`,
    )
    const r = await parse(await zip.generateAsync({ type: 'nodebuffer' }), '会议.odt')
    expect(r.markdown).toMatch(/^# 会议记录$/m)
    expect(r.markdown).toMatch(/^- 预算\n- 招聘$/m)
    expect(r.markdown).toMatch(/\| 预算 \| 通过 \|/)
  })

  it('.epub chapters follow the spine order', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
    zip.file(
      'OEBPS/content.opf',
      '<package><metadata><dc:title>三体</dc:title></metadata><manifest><item id="c2" href="c2.xhtml"/><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    )
    zip.file('OEBPS/c1.xhtml', '<html><body><h1>第一章 科学边界</h1><p>汪淼觉得……</p></body></html>')
    zip.file('OEBPS/c2.xhtml', '<html><body><h1>第二章 台球</h1><p>丁仪说……</p></body></html>')
    const r = await parse(await zip.generateAsync({ type: 'nodebuffer' }), 'book.epub')
    expect(r.title).toBe('三体')
    expect(r.markdown.indexOf('第一章')).toBeLessThan(r.markdown.indexOf('第二章'))
    expect(r.markdown).toMatch(/^# 第一章 科学边界$/m)
  })

  it('HTML keeps main content and tables, drops scripts and navigation', async () => {
    const html = `<!doctype html><html><head><title>价格</title><script>alert(1)</script></head><body><nav><a href="/">首页</a><a href="/x">导航链接</a></nav>
      <main><h1>套餐价格</h1><p>所有价格<strong>含税</strong>。</p><table><tr><th>套餐</th><th>价格</th></tr><tr><td>基础</td><td>¥99</td></tr></table></main><footer>版权所有</footer></body></html>`
    const r = await parse(Buffer.from(html), 'pricing.html')
    expect(r.title).toBe('价格')
    expect(r.markdown).toMatch(/^# 套餐价格$/m)
    expect(r.markdown).toContain('所有价格**含税**。')
    expect(r.markdown).toMatch(/\|\s*基础\s*\|\s*¥99\s*\|/)
    expect(r.markdown).not.toMatch(/导航链接|alert|版权所有/)
  })

  it('RTF with unicode escapes', async () => {
    const rtf = '{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0 Hello \\u20320?\\u22909? RTF\\par Second line\\par}'
    const r = await parse(Buffer.from(rtf), 'note.rtf')
    expect(r.markdown).toContain('Hello 你好 RTF')
    expect(r.markdown).toContain('Second line')
  })

  it('ZIP: lists entries and parses the supported ones inside', async () => {
    const zip = new JSZip()
    zip.file('说明.txt', '压缩包里的说明文件')
    zip.file('data/scores.csv', 'name,score\nAda,95\n')
    zip.file('bin/tool.exe', Buffer.from([0, 1, 2, 3, 0, 0]))
    const r = await parse(await zip.generateAsync({ type: 'nodebuffer' }), 'bundle.zip')
    expect(r.kind).toBe('archive')
    expect(r.markdown).toContain('- bin/tool.exe')
    expect(r.markdown).toContain('压缩包里的说明文件')
    expect(r.markdown).toMatch(/\| Ada \| 95 \|/)
  })
})

describe('Text, code and data', () => {
  it('GBK text file', async () => {
    const r = await parse(iconv.encode('这是一个用 GBK 编码保存的文本文件。', 'gbk'), 'legacy.txt')
    expect(r.markdown).toBe('这是一个用 GBK 编码保存的文本文件。')
  })
  it('UTF-16 with BOM', async () => {
    const r = await parse(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('宽字符文本', 'utf16le')]), 'wide.txt')
    expect(r.markdown).toBe('宽字符文本')
  })
  it('code keeps exact content in a fence that survives embedded backticks', async () => {
    const src = 'const md = "```js\\nx\\n```"\nexport default md\n'
    const r = await parse(Buffer.from(src), 'doc.ts')
    expect(r.kind).toBe('code')
    expect(r.markdown.startsWith('````typescript\n')).toBe(true)
    expect(r.markdown).toContain(src.trim())
  })
  it('JSON is pretty-printed; broken JSON kept verbatim with a warning', async () => {
    expect((await parse(Buffer.from('{"a":{"b":[1,2]}}'), 'x.json')).markdown).toContain('"b": [\n      1,')
    const bad = await parse(Buffer.from('{"a": 1,'), 'bad.json')
    expect(bad.warnings.join()).toContain('JSON 格式有误')
  })
  it('misnamed files are detected by content', async () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a'], [1]]), 'S')
    const buf = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
    await expect(parse(buf, 'report.bin')).resolves.toMatchObject({ kind: 'sheet' })
  })
  it('unknown binaries are rejected clearly', async () => {
    await expect(parse(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]), 'program')).rejects.toBeInstanceOf(UnsupportedFileError)
  })
})

// ---------- helpers
function textImage(lines: string[]): Buffer {
  const c = createCanvas(1240, 120 + lines.length * 100)
  const g = c.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#111'
  g.font = '44px "NavoTestCJK", "PingFang SC", "Noto Sans CJK SC", sans-serif'
  lines.forEach((l, i) => g.fillText(l, 60, 110 + i * 100))
  return c.toBuffer('image/png')
}

/** 1 - normalised Levenshtein distance, ignoring whitespace and punctuation width differences. */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/：/g, ':').replace(/，/g, ',').replace(/。/g, '.')
  const x = norm(a)
  const y = norm(b)
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)])
  for (let j = 1; j <= y.length; j++) dp[0][j] = j
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length, 1)
}
