import { Globe, Maximize2, X } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Skeleton } from '@/components/ui/states'
import { call } from '@/lib/ipc'
import { useBrowser } from '@/stores/browser'

const MIN_W = 220
const MAX_W = 640
const POS_KEY = 'browser.mini.rect'
// top-right, below the page header: clear of the chat composer at the bottom
const DEFAULT: Rect = { right: 16, top: 60, width: 320 }

type Rect = { right: number; top: number; width: number }

function readRect(): Rect {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as Rect | null
    return p && [p.right, p.top, p.width].every(Number.isFinite) ? p : DEFAULT
  } catch {
    return DEFAULT
  }
}

/**
 * Floating live preview of the agent's browser while the panel is collapsed.
 * Drag the header to move it; double-click (or the expand button) opens the panel.
 */
export function BrowserMini() {
  const { state, preview, setOpen, setMini } = useBrowser()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Rect>(readRect)
  const drag = useRef<{ x: number; y: number; start: Rect; moved: boolean; resize: boolean } | null>(null)
  const tab = state.tabs.find((t) => t.active)
  const frame = preview && preview.tabId === tab?.id ? preview.image : null
  const running = state.agentControlled

  useEffect(() => {
    void call('browser.setPreview', true)
    return () => void call('browser.setPreview', false)
  }, [])

  // keep it inside the content area when the window shrinks
  const clamp = (p: Rect): Rect => {
    const parent = ref.current?.parentElement?.getBoundingClientRect()
    const box = ref.current?.getBoundingClientRect()
    if (!parent || !box) return p
    const width = Math.min(Math.max(p.width, MIN_W), Math.min(MAX_W, parent.width - 16))
    const height = (box.height / box.width) * width
    return {
      width,
      right: Math.min(Math.max(p.right, 8), Math.max(8, parent.width - width - 8)),
      top: Math.min(Math.max(p.top, 8), Math.max(8, parent.height - height - 8)),
    }
  }
  useEffect(() => {
    const fn = () => setPos((p) => clamp(p))
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    drag.current = { x: e.clientX, y: e.clientY, start: pos, moved: false, resize: !!(e.target as HTMLElement).closest('[data-resize]') }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 3) return
    d.moved = true
    // the resize grip sits bottom-left (the window is anchored right): dragging it left grows the window
    setPos(clamp(d.resize ? { ...d.start, width: d.start.width - dx } : { ...d.start, right: d.start.right - dx, top: d.start.top + dy }))
  }
  const onPointerUp = () => {
    if (drag.current?.moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch {
        /* ignore */
      }
    }
    drag.current = null
  }

  const expand = () => setOpen(true)

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label="浏览器小窗，双击展开"
      data-testid="browser-mini"
      onDoubleClick={expand}
      onKeyDown={(e) => e.key === 'Enter' && expand()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ right: pos.right, top: pos.top, width: pos.width }}
      className="group absolute z-30 animate-fade-in cursor-grab overflow-hidden rounded-lg border border-border bg-card shadow-float select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none active:cursor-grabbing"
      title="双击展开浏览器"
    >
      <div className="flex h-8 items-center gap-2 border-b border-border px-2.5">
        {running ? (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-label="Agent 正在操作" />
        ) : tab?.favicon ? (
          <img src={tab.favicon} alt="" className="size-3.5 shrink-0" />
        ) : (
          <Globe className="size-3.5 shrink-0 text-subtle-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {running ? 'Agent 正在操作 · ' : ''}
          {tab?.title || tab?.url || '浏览器'}
        </span>
        <button className="interactive rounded-sm p-0.5 text-subtle-foreground hover:bg-accent hover:text-foreground" onClick={expand} aria-label="展开浏览器">
          <Maximize2 className="size-3.5" />
        </button>
        <button
          className="interactive rounded-sm p-0.5 text-subtle-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setMini(false)}
          aria-label="关闭小窗"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="relative aspect-[16/10] bg-muted">
        {frame ? (
          <img src={frame} alt="浏览器实时画面" draggable={false} className="size-full object-cover object-top" />
        ) : tab ? (
          <Skeleton className="size-full rounded-none" />
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-muted-foreground">还没有打开的页面</div>
        )}
        {tab?.loading ? <div className="absolute inset-x-0 top-0 h-0.5 animate-progress bg-brand/70" /> : null}
        <span
          data-resize
          aria-hidden
          title="拖动调整大小"
          className="absolute bottom-0 left-0 flex size-5 cursor-nesw-resize items-end justify-start p-1 text-white/80 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        >
          <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1 3 7 9M1 7l2 2" />
          </svg>
        </span>
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-sm bg-black/60 px-2 py-0.5 text-[11px] text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          双击展开
        </span>
      </div>
    </div>
  )
}
