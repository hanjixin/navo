import mammoth from 'mammoth'
import { htmlToMarkdown } from './html'

/**
 * Word (.docx) via mammoth: maps Word styles to semantic HTML (headings, lists, tables, bold/italic,
 * footnotes), which then becomes Markdown. Custom "Title"/"Subtitle" styles are mapped too.
 */
export async function parseDocx(buf: Buffer): Promise<{ markdown: string; warnings: string[]; title?: string }> {
  const res = await mammoth.convertToHtml(
    { buffer: buf },
    {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='标题'] => h1:fresh",
        "p[style-name='副标题'] => h2:fresh",
      ],
      convertImage: mammoth.images.imgElement(async (img) => ({ src: '', alt: (img as { altText?: string }).altText ?? '' })),
    },
  )
  const warnings = [...new Set(res.messages.filter((m) => m.type === 'warning' && !/unrecognised|unrecognized/i.test(m.message)).map((m) => m.message))].slice(
    0,
    5,
  )
  const markdown = htmlToMarkdown(res.value)
  const title = /^# (.+)$/m.exec(markdown)?.[1]
  return { markdown, warnings, title }
}
