import JSZip from 'jszip'
import { posix } from 'node:path'
import { parseHtml } from './html'
import { tidyMarkdown } from '../text-utils'

/** EPUB: chapters in spine (reading) order, each XHTML chapter converted to Markdown. */
export async function parseEpub(buf: Buffer): Promise<{ markdown: string; title?: string; chapters: number }> {
  const zip = await JSZip.loadAsync(buf)
  const container = await zip.file('META-INF/container.xml')?.async('string')
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1]
  if (!opfPath) throw new Error('无效的 EPUB：缺少 container.xml')
  const opf = await zip.file(opfPath)!.async('string')
  const base = posix.dirname(opfPath)
  const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1]?.trim()
  const manifest = new Map<string, string>()
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1]
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1]
    if (id && href) manifest.set(id, posix.join(base, decodeURIComponent(href)))
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1])).filter((p): p is string => !!p)
  const parts: string[] = []
  for (const p of spine) {
    const html = await zip.file(p)?.async('string')
    if (!html) continue
    const md = parseHtml(html).markdown
    if (md.trim()) parts.push(md)
  }
  return { markdown: tidyMarkdown(parts.join('\n\n---\n\n')), title, chapters: parts.length }
}
