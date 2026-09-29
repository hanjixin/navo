import domino from '@mixmark-io/domino'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { normalizeCjk, tidyMarkdown } from '../text-utils'

/** HTML → Markdown with GFM tables / strikethrough / task lists; scripts, styles and navigation chrome dropped. */
export function htmlToMarkdown(html: string, opts: { dropChrome?: boolean } = {}): string {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' })
  td.use(gfm)
  td.remove(['script', 'style', 'noscript', 'template', 'iframe', 'canvas', 'form'])
  td.remove((node) => node.nodeName.toLowerCase() === 'svg')
  if (opts.dropChrome) td.remove(['nav', 'header', 'footer', 'aside'])
  // images: keep alt text, drop (often huge) data URLs
  td.addRule('image', {
    filter: 'img',
    replacement: (_c, node) => {
      const el = node as HTMLImageElement
      const alt = (el.getAttribute('alt') || '').trim()
      const src = el.getAttribute('src') || ''
      if (src.startsWith('data:') || !src) return alt ? `[图片：${alt}]` : '[图片]'
      return `![${alt}](${src})`
    },
  })
  // Parse ourselves and hand turndown a DOM node: its own string parsing does a lazy require() that
  // breaks once bundled as ESM.
  const root = domino.createDocument(`<!doctype html><html><body><div id="navo-root">${html}</div></body></html>`).getElementById('navo-root')
  return tidyMarkdown(normalizeCjk(td.turndown(root as unknown as HTMLElement)))
}

export function parseHtml(html: string): { markdown: string; title?: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() || undefined
  // prefer the main content region of saved web pages
  const main = /<(main|article)[\s>][\s\S]*<\/\1>/i.exec(html)?.[0]
  return { markdown: htmlToMarkdown(main ?? html, { dropChrome: !main }), title }
}
