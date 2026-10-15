import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { exportTargets, jsonRows, kindOf, markdownTables, markdownToDocx, markdownToHtml, toXlsx } from '../src/main/outputs/convert'

const REPORT = `# 竞品周报

本周 **三家** 竞品都有动作，详见 [官网](https://example.com)。

## 价格

| 产品 | 价格 | 变化 |
| --- | ---: | --- |
| A | 1599 | -100 |
| B | 2999 | 0 |

1. 第一条结论
2. 第二条结论
   - 补充说明

\`\`\`
raw code
\`\`\`
`

const sheetRows = (buf: Buffer, i = 0) => {
  const wb = XLSX.read(buf)
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[i]], { header: 1 })
}

describe('kinds and targets', () => {
  it('knows what a file is and what it can become', () => {
    expect(kindOf('周报.md')).toBe('markdown')
    expect(kindOf('data.CSV')).toBe('table')
    expect(kindOf('a.bin')).toBe('other')
    expect(exportTargets('周报.md', REPORT)).toEqual(['docx', 'pdf', 'xlsx'])
    expect(exportTargets('notes.md', '# 没有表格')).toEqual(['docx', 'pdf'])
    expect(exportTargets('page.html')).toEqual(['pdf'])
    expect(exportTargets('data.csv')).toEqual(['xlsx'])
    expect(exportTargets('list.json', '[{"a":1}]')).toEqual(['xlsx'])
    expect(exportTargets('conf.json', '{"a":1}')).toEqual([])
    expect(exportTargets('photo.png')).toEqual([])
  })
})

describe('tables', () => {
  it('JSON records and nested lists become rows', () => {
    expect(jsonRows('[{"名称":"A","价格":1},{"名称":"B","备注":"x"}]')).toEqual([
      ['名称', '价格', '备注'],
      ['A', 1, ''],
      ['B', '', 'x'],
    ])
    expect(jsonRows('{"items":[[1,2],[3,4]]}')).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(jsonRows('{"a":1}')).toBeNull()
    expect(jsonRows('not json')).toBeNull()
  })
  it('Markdown tables', () => {
    expect(markdownTables(REPORT)).toEqual([
      [
        ['产品', '价格', '变化'],
        ['A', '1599', '-100'],
        ['B', '2999', '0'],
      ],
    ])
  })
  it('to Excel, with numbers as numbers', () => {
    expect(sheetRows(toXlsx('d.csv', Buffer.from('\uFEFF名称,价格\nA,1599\nB,2999\n')))).toEqual([
      ['名称', '价格'],
      ['A', 1599],
      ['B', 2999],
    ])
    expect(sheetRows(toXlsx('r.md', Buffer.from(REPORT)))[1]).toEqual(['A', 1599, -100])
    expect(sheetRows(toXlsx('l.json', Buffer.from('[{"a":"1.5","b":"x"}]')))).toEqual([
      ['a', 'b'],
      [1.5, 'x'],
    ])
    expect(() => toXlsx('n.md', Buffer.from('# 无表格'))).toThrow('没有表格')
  })
})

describe('documents', () => {
  it('Markdown → Word keeps headings, emphasis, links, lists, tables and code', async () => {
    const zip = await JSZip.loadAsync(await markdownToDocx(REPORT, '竞品周报'))
    const xml = await zip.file('word/document.xml')!.async('string')
    for (const t of ['竞品周报', '三家', '官网', '第一条结论', '补充说明', '1599', 'raw code']) expect(xml).toContain(t)
    expect(xml).toContain('Heading1')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toMatch(/<w:b\/>[\s\S]*三家/)
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain('https://example.com')
  })
  it('Markdown → HTML for printing', () => {
    const html = markdownToHtml(REPORT, '竞品周报 <1>')
    expect(html).toContain('<title>竞品周报 &lt;1&gt;</title>')
    expect(html).toContain('<table>')
    expect(html).toContain('@page')
  })
})

describe('legacy encodings', () => {
  it('a GBK CSV (as old systems export it) converts with its Chinese intact', async () => {
    const iconv = (await import('iconv-lite')).default
    const gbk = iconv.encode('单号,金额\nA-1,100\n', 'gbk')
    expect(sheetRows(toXlsx('orders.csv', gbk))).toEqual([
      ['单号', '金额'],
      ['A-1', 100],
    ])
  })
})
