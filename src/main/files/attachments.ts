import { readFileSync } from 'node:fs'
import type { FileRecord, MessageAttachment } from '@shared/types'

/** Total parsed text sent inline with a message; larger files are previewed and read on demand. */
export const INLINE_BUDGET = 24_000
const PREVIEW = 3_000
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

const attr = (s: string) => s.replace(/"/g, '&quot;')

/** images attached per message (vision models); further ones stay available as OCR text */
export const MAX_IMAGES = 12
const OCR_REFERENCE = 2_000

const dataUrl = (path: string, mime = 'image/jpeg') => `data:${mime};base64,${readFileSync(path).toString('base64')}`

/**
 * Turns parsed attachments into model context: full Markdown while it fits the budget, otherwise a
 * preview plus the /uploads/ path the agent can read_file (with offset/limit) for the rest.
 * With a vision model, pictures and scanned PDF pages go along as images, and OCR text is reduced
 * to a short reference.
 */
export function buildAttachmentContext(
  records: FileRecord[],
  read: (r: FileRecord) => string,
  original: (r: FileRecord) => string,
  vision: boolean,
  visuals: (r: FileRecord) => string[] = () => [],
): { context: string; attachments: MessageAttachment[]; images: string[] } {
  const attachments = records.map((r) => ({ id: r.id, name: r.name, kind: r.kind, chars: r.chars }))
  const images: string[] = []
  let budget = INLINE_BUDGET
  const blocks: string[] = []
  // smaller files first so more of them fit entirely
  for (const r of [...records].sort((a, b) => (a.chars ?? 0) - (b.chars ?? 0))) {
    const attached: { url: string; page?: number }[] = []
    if (vision && r.status === 'ready') {
      const room = MAX_IMAGES - images.length
      const ready = visuals(r)
      if (ready.length) for (const v of ready.slice(0, room)) attached.push({ url: dataUrl(v), page: Number(/page-(\d+)\.jpg$/.exec(v)?.[1]) || undefined })
      else if (IMAGE_MIME[r.ext] && r.size <= IMAGE_MAX_BYTES && room > 0) attached.push({ url: dataUrl(original(r), IMAGE_MIME[r.ext]) })
    }
    const indices = attached.map((_, k) => images.length + k + 1)
    images.push(...attached.map((a) => a.url))
    const meta = [
      `name="${attr(r.name)}"`,
      `path="${attr(r.agentPath)}"`,
      r.kind ? `type="${r.kind}"` : '',
      r.units ? `${r.unitLabel === '页' ? 'pages' : 'parts'}="${r.units}"` : '',
      indices.length ? `images="${indices.join(',')}"` : '',
    ]
      .filter(Boolean)
      .join(' ')
    if (r.status !== 'ready') {
      blocks.push(`<file ${meta} status="error">\n解析失败：${r.error ?? '未知错误'}\n</file>`)
      continue
    }
    let md = read(r).replace(/^# .+\n+/, '')
    let note = r.warnings.length ? `\n（解析提示：${r.warnings.join('；')}）` : ''
    if (r.kind === 'image' && attached.length) {
      // the model sees the picture itself; OCR text only helps with exact characters
      const ocr = /^_（图片/.test(md.trim()) ? '' : md.trim()
      note = `\n（图片已作为第 ${indices[0]} 张图像随消息附上，请直接看图作答。${ocr ? '以下 OCR 文字仅供核对。' : ''}）`
      md = ocr.length > OCR_REFERENCE ? `${ocr.slice(0, OCR_REFERENCE)}\n…（OCR 全文见 path）` : ocr
    } else if (attached.some((a) => a.page)) {
      const pages = attached.filter((a) => a.page).map((a) => a.page)
      note += `\n（第 ${pages.join('、')} 页是扫描件，页面图像已按顺序作为第 ${indices.join('、')} 张图像附上；文中这些页的内容来自 OCR，有出入时以图像为准。）`
    } else if (r.kind === 'image') note += '\n（当前模型不支持看图，以下是 OCR 识别出的文字。）'
    if (md.length <= budget) {
      budget -= md.length
      blocks.push(`<file ${meta}>${note}\n${md}\n</file>`)
    } else {
      const head = md.slice(0, Math.min(PREVIEW, Math.max(budget, 0)))
      budget -= head.length
      blocks.push(
        `<file ${meta} truncated="true" chars="${md.length}">${note}\n（内容较长，共 ${md.length.toLocaleString()} 字，以下是开头部分。需要其余内容时用 read_file 读取 path，可配合 offset / limit 分段读取。）\n\n${head}\n</file>`,
      )
    }
  }
  const context = blocks.length ? `用户上传了 ${records.length} 个文件（已解析为 Markdown）：\n\n${blocks.join('\n\n')}` : ''
  return { context, attachments, images }
}
