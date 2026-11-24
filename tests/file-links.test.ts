import { describe, expect, it } from 'vitest'
import {
  fileReferenceFromHref,
  fileReferenceHref,
  normalizeFileReference,
  rehypeFileLinks,
  sameFileReference,
  type FileLinkHastNode,
} from '../src/shared/file-link'

describe('Markdown file references', () => {
  it('normalizes workspace paths and file URLs', () => {
    expect(normalizeFileReference('`/workspace/gta-mini.html`')).toBe('/workspace/gta-mini.html')
    expect(normalizeFileReference('workspace/report.pdf')).toBe('/workspace/report.pdf')
    expect(normalizeFileReference('file:///workspace/%E5%91%A8%E6%8A%A5.md')).toBe('/workspace/周报.md')
    expect(normalizeFileReference('https://example.com/workspace/file.md')).toBeNull()
    expect(normalizeFileReference('src/main/index.ts')).toBeNull()
  })

  it('round-trips internal links and matches equivalent paths', () => {
    const href = fileReferenceHref('/workspace/周报.md')
    expect(fileReferenceFromHref(href)).toBe('/workspace/周报.md')
    expect(fileReferenceFromHref('https://example.com')).toBeNull()
    expect(sameFileReference('workspace/周报.md', '/workspace/周报.md')).toBe(true)
    expect(sameFileReference('/workspace/a.md', '/workspace/b.md')).toBe(false)
  })

  it('links inline and plain file paths but leaves fenced code alone', () => {
    const tree: FileLinkHastNode = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: '文件：/workspace/gta-mini.html' }] },
        { type: 'element', tagName: 'p', children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: '/workspace/report.md' }] }] },
        { type: 'element', tagName: 'pre', children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: '/workspace/raw.md' }] }] },
      ],
    }
    rehypeFileLinks()(tree)
    const links = tree.children?.flatMap((node) => node.children?.filter((child) => child.tagName === 'a') ?? []) ?? []
    expect(links.map((link) => fileReferenceFromHref(link.properties?.href as string))).toEqual(['/workspace/gta-mini.html', '/workspace/report.md'])
    expect(tree.children?.at(-1)?.children?.[0]?.tagName).toBe('code')
  })
})
