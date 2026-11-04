export type Rect = { x: number; y: number; width: number; height: number }
export type DesktopWindow = { id: string; pid: number; bounds: Rect; title?: string }
export type DesktopApp = { bundleId: string; name: string; pid: number; windows?: string[]; window?: DesktopWindow }
export type AXNode = {
  id: string
  role: string
  title?: string
  value?: string
  placeholder?: string
  identifier?: string
  focused?: boolean
  enabled: boolean
  frame?: Rect
  depth: number
}
export type AXTree = { app: DesktopApp; nodes: AXNode[]; window?: DesktopWindow }
export type Screenshot = { data: string; width: number; height: number; bounds: Rect; window?: DesktopWindow }
type Target = { id: string; bundleId: string; frame?: Rect; window?: DesktopWindow }

/** Validate and copy native window identity before retaining it across requests. */
export function copyWindow(window: DesktopWindow | undefined): DesktopWindow | undefined {
  if (!window || typeof window.id !== 'string' || !window.id || !Number.isInteger(window.pid) || window.pid <= 0) return undefined
  const bounds = window.bounds
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return undefined
  return { ...window, bounds: { ...bounds } }
}

export function sameWindow(a: DesktopWindow | undefined, b: DesktopWindow | undefined): boolean {
  const first = copyWindow(a),
    second = copyWindow(b)
  return !!(
    first &&
    second &&
    first.id === second.id &&
    first.pid === second.pid &&
    first.bounds.x === second.bounds.x &&
    first.bounds.y === second.bounds.y &&
    first.bounds.width === second.bounds.width &&
    first.bounds.height === second.bounds.height
  )
}

/** Match AX text before escaping or the display budget can omit the target. */
export function treeContainsText(tree: AXTree, text: string): boolean {
  const needle = text.replace(/\r\n/g, '\n')
  return [tree.app.name, tree.window?.title, ...tree.nodes.flatMap((node) => [node.title, node.value, node.placeholder, node.identifier])].some(
    (value) => typeof value === 'string' && value.replace(/\r\n/g, '\n').includes(needle),
  )
}

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
    const candidates = tree.nodes.map((node, index) => {
      const ref = `d${this.nextRef++}`
      const depth = Number.isFinite(node.depth) ? Math.min(30, Math.max(0, Math.floor(node.depth))) : 0
      const line = `${'  '.repeat(depth)}[${ref}] ${node.role}${node.title ? ` ${JSON.stringify(node.title)}` : ''}${node.value !== undefined ? ` value=${JSON.stringify(node.value)}` : ''}${node.placeholder ? ` placeholder=${JSON.stringify(node.placeholder)}` : ''}${node.identifier ? ` identifier=${JSON.stringify(node.identifier)}` : ''}${node.focused ? ' (focused)' : ''}${node.enabled ? '' : ' (disabled)'}`
      const priority = node.focused
        ? 0
        : ['AXApplication', 'AXWindow', 'AXSheet', 'AXDialog'].includes(node.role)
          ? 1
          : ['AXTextArea', 'AXTextField', 'AXSearchField', 'AXComboBox'].includes(node.role)
            ? 2
            : /^(AXButton|AXCheckBox|AXRadioButton|AXPopUpButton|AXMenuButton|AXLink|AXSlider|AXTab)$/.test(node.role)
              ? 3
              : 4
      return { node, ref, line, priority, index }
    })
    // Long chat histories must not use the entire budget before their composer is reached.
    // Select controls first, then print the retained nodes in their original tree order.
    const selected = new Set<number>()
    let remaining = budget - used
    for (const candidate of [...candidates].sort((a, b) => a.priority - b.priority || a.index - b.index)) {
      const size = candidate.line.length + (lines.length || selected.size ? 1 : 0)
      if (size > remaining) continue
      selected.add(candidate.index)
      remaining -= size
    }
    for (const { node, ref, line, index } of candidates) {
      if (!selected.has(index) || !append(line)) continue
      this.refs.set(ref, { id: node.id, bundleId: tree.app.bundleId, ...(node.frame ? { frame: { ...node.frame } } : {}), window: copyWindow(tree.window) })
    }
    const omitted = tree.nodes.length - this.refs.size
    if (omitted) append(`… ${omitted} 个元素因预算省略`)
    return lines.join('\n')
  }

  get(ref: string): Target {
    const target = this.refs.get(ref.replace(/^\[(d\d+)\]$/, '$1'))
    if (!target) throw new Error(`桌面元素 ${ref} 已失效，请重新获取快照`)
    return { ...target, ...(target.frame ? { frame: { ...target.frame } } : {}), window: copyWindow(target.window) }
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
