const FILE_HREF_PREFIX = '#navo-file='
const WORKSPACE_PATH = /^(?:\/workspace\/|~\/)/

/** Normalize file references emitted by an Agent without treating arbitrary Markdown as paths. */
export function normalizeFileReference(value: string): string | null {
  let path = value.trim().replace(/^`|`$/g, '')
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return null
    }
  }
  if (path.startsWith('workspace/')) path = `/${path}`
  if (path.length > 2_048 || /[\0\r\n<>]/.test(path) || !WORKSPACE_PATH.test(path)) return null
  return path
}

export function fileReferenceHref(path: string): string {
  return `${FILE_HREF_PREFIX}${encodeURIComponent(path)}`
}

export function fileReferenceFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(FILE_HREF_PREFIX)) return null
  try {
    return normalizeFileReference(decodeURIComponent(href.slice(FILE_HREF_PREFIX.length)))
  } catch {
    return null
  }
}

export function sameFileReference(a: string, b: string): boolean {
  const left = normalizeFileReference(a)
  const right = normalizeFileReference(b)
  return !!left && left === right
}

export interface FileLinkHastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: FileLinkHastNode[]
}

const textOf = (node: FileLinkHastNode): string => (node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join(''))

function fileLink(path: string, children: FileLinkHastNode[] = [{ type: 'text', value: path }]): FileLinkHastNode {
  return { type: 'element', tagName: 'a', properties: { href: fileReferenceHref(path) }, children }
}

function trimPathEnd(value: string): string {
  return value.replace(/[.,;:!?，。；：！？)）\]]+$/, '')
}

/** Turn file references into internal links without touching fenced code or existing links. */
export function rehypeFileLinks() {
  const rewrite = (node: FileLinkHastNode): void => {
    if (!node.children?.length) return
    const next: FileLinkHastNode[] = []
    for (const child of node.children) {
      if (child.type === 'element' && child.tagName === 'a') {
        next.push(child)
        continue
      }
      if (child.type === 'element' && child.tagName === 'pre') {
        next.push(child)
        continue
      }
      if (child.type === 'element' && child.tagName === 'code') {
        const path = normalizeFileReference(textOf(child))
        next.push(path ? fileLink(path, [child]) : child)
        continue
      }
      if (child.type === 'text') {
        const value = child.value ?? ''
        const matches = [...value.matchAll(/(?:\/workspace\/|~\/)[^\s<>"'`]+/g)]
        if (!matches.length) {
          next.push(child)
          continue
        }
        let cursor = 0
        for (const match of matches) {
          const index = match.index ?? 0
          const raw = match[0]
          const path = normalizeFileReference(trimPathEnd(raw))
          if (!path) continue
          if (index > cursor) next.push({ type: 'text', value: value.slice(cursor, index) })
          next.push(fileLink(path))
          cursor = index + path.length
        }
        if (cursor < value.length) next.push({ type: 'text', value: value.slice(cursor) })
        continue
      }
      rewrite(child)
      next.push(child)
    }
    node.children = next
  }
  return (tree: FileLinkHastNode) => rewrite(tree)
}
