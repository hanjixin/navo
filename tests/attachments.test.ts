import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileRecord } from '../src/shared/types'
import { buildAttachmentContext, MAX_IMAGES } from '../src/main/files/attachments'

const dir = mkdtempSync(join(tmpdir(), 'navo-att-'))
const jpg = join(dir, 'image.jpg')
writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
const page = (n: number) => {
  const p = join(dir, `page-${n}.jpg`)
  writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  return p
}

const rec = (over: Partial<FileRecord>): FileRecord =>
  ({
    id: 'f1',
    name: 'shot.png',
    ext: 'png',
    size: 10,
    kind: 'image',
    status: 'ready',
    chars: 20,
    warnings: [],
    ocrPages: [],
    agentPath: '/uploads/f1.md',
    ...over,
  }) as FileRecord

describe('buildAttachmentContext', () => {
  const md = '# shot.png\n\n订单号 A-1024 已发货'

  it('vision: sends the picture itself and keeps OCR only as a reference', () => {
    const r = buildAttachmentContext(
      [rec({})],
      () => md,
      () => jpg,
      true,
      () => [jpg],
    )
    expect(r.images).toHaveLength(1)
    expect(r.images[0].startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(r.context).toContain('images="1"')
    expect(r.context).toContain('请直接看图')
    expect(r.context).toContain('A-1024')
  })

  it('no vision: OCR text only, no images', () => {
    const r = buildAttachmentContext(
      [rec({})],
      () => md,
      () => jpg,
      false,
      () => [jpg],
    )
    expect(r.images).toHaveLength(0)
    expect(r.context).toContain('当前模型不支持看图')
    expect(r.context).not.toContain('images=')
  })

  it('image without a model-ready copy falls back to the original', () => {
    const r = buildAttachmentContext(
      [rec({})],
      () => md,
      () => jpg,
      true,
      () => [],
    )
    expect(r.images[0].startsWith('data:image/png;base64,')).toBe(true)
  })

  it('empty OCR is not passed along as text', () => {
    const r = buildAttachmentContext(
      [rec({})],
      () => '# a\n\n_（图片中没有识别到文字）_',
      () => jpg,
      true,
      () => [jpg],
    )
    expect(r.context).not.toContain('没有识别到文字')
  })

  it('scanned PDF pages go as images and are referenced by page', () => {
    const pdf = rec({ id: 'p', name: 'scan.pdf', ext: 'pdf', kind: 'pdf', units: 3, unitLabel: '页' })
    const r = buildAttachmentContext(
      [pdf],
      () => '# scan.pdf\n\n文字',
      () => '',
      true,
      () => [page(2), page(3)],
    )
    expect(r.images).toHaveLength(2)
    expect(r.context).toContain('第 2、3 页是扫描件')
    expect(r.context).toContain('images="1,2"')
  })

  it('caps images per message', () => {
    const many = Array.from({ length: MAX_IMAGES + 3 }, (_, i) => rec({ id: `f${i}`, chars: i }))
    const r = buildAttachmentContext(
      many,
      () => md,
      () => jpg,
      true,
      () => [jpg],
    )
    expect(r.images).toHaveLength(MAX_IMAGES)
  })
})
