export type Rect = { x: number; y: number; width: number; height: number }
export type DesktopApp = { bundleId: string; name: string; pid: number; windows?: string[] }
export type AXNode = { id: string; role: string; title?: string; value?: string; enabled: boolean; frame?: Rect; depth: number }
export type AXTree = { app: DesktopApp; nodes: AXNode[] }
export type Screenshot = { data: string; width: number; height: number; bounds: Rect }
type Target = { id: string; bundleId: string; frame?: Rect }

/** References deliberately expire at every capture, including unchanged captures. */
export class DesktopSnapshot {
  private nextRef = 1
  private refs = new Map<string, Target>()
  private previous: string | undefined

  update(tree: AXTree, budget = 12_000): string {
    if (!Number.isFinite(budget) || budget < 0) throw new Error('快照预算必须是非负有限数字')
    budget = Math.floor(budget)
    this.refs.clear()
    this.previous = JSON.stringify(tree)
    const lines: string[] = []
    let used = 0
    const append = (line: string) => {
      const size = line.length + (lines.length ? 1 : 0)
      if (used + size > budget) return false
      lines.push(line)
      used += size
      return true
    }
    append(`${JSON.stringify(tree.app.name)} (${tree.app.bundleId})`)
    let omitted = 0
    for (const node of tree.nodes) {
      const ref = `d${this.nextRef++}`
      const depth = Number.isFinite(node.depth) ? Math.min(30, Math.max(0, Math.floor(node.depth))) : 0
      const line = `${'  '.repeat(depth)}[${ref}] ${node.role}${node.title ? ` ${JSON.stringify(node.title)}` : ''}${node.value ? ` value=${JSON.stringify(node.value)}` : ''}${node.enabled ? '' : ' (disabled)'}`
      if (append(line)) {
        this.refs.set(ref, { id: node.id, bundleId: tree.app.bundleId, ...(node.frame ? { frame: { ...node.frame } } : {}) })
      } else omitted++
    }
    if (omitted) append(`… ${omitted} 个元素因预算省略`)
    return lines.join('\n')
  }

  get(ref: string): Target {
    const target = this.refs.get(ref.replace(/^\[(d\d+)\]$/, '$1'))
    if (!target) throw new Error(`桌面元素 ${ref} 已失效，请重新获取快照`)
    return { ...target, ...(target.frame ? { frame: { ...target.frame } } : {}) }
  }

  diff(tree: AXTree, budget = 12_000): string {
    // Return refreshed references even for unchanged trees; never leave callers using stale IDs.
    const unchanged = this.previous === JSON.stringify(tree)
    const prefix = unchanged ? '界面未变化；以下为最新元素引用：\n' : ''
    if (budget < prefix.length) return this.update(tree, budget)
    return prefix + this.update(tree, budget - prefix.length)
  }

  clear(): void {
    this.refs.clear()
    this.previous = undefined
  }
}

/** Screenshot coordinates are image pixels; native input uses global desktop points. */
export function screenshotPoint(image: Screenshot, x: number, y: number): { x: number; y: number } {
  const b = image.bounds
  if (
    ![x, y, image.width, image.height, b.x, b.y, b.width, b.height].every(Number.isFinite) ||
    image.width <= 0 ||
    image.height <= 0 ||
    b.width <= 0 ||
    b.height <= 0 ||
    x < 0 ||
    y < 0 ||
    x >= image.width ||
    y >= image.height
  ) {
    throw new Error('截图坐标无效或超出截图边界')
  }
  const result = { x: b.x + (x / image.width) * b.width, y: b.y + (y / image.height) * b.height }
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new Error('截图坐标超出有效范围')
  return result
}
