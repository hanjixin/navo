import { ArrowLeft, ArrowRight, Circle, ExternalLink, Globe, Hand, Loader2, Plus, RotateCw, Square, SquareTerminal, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { call } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'
import { useBrowser } from '@/stores/browser'
import { BROWSER_DEFAULT, BROWSER_MIN, browserMax, sidebarCollapsed, useLayout } from '@/stores/layout'
import { useOverlayStore } from '@/stores/overlay'
import { useSettings } from '@/stores/settings'
import { t } from '@shared/i18n'

const GUTTER = 6
/** Dragging this far below the minimum width collapses the panel on release. */
const COLLAPSE_SLACK = 120

export function BrowserPanel() {
  const { state, width, setWidth, setOpen, recordingSteps, lastRecorded } = useBrowser()
  const overlays = useOverlayStore((s) => s.count)
  const devMode = useSettings((s) => s.settings?.devMode)
  const windowWidth = useLayout((s) => s.windowWidth)
  const collapsed = useLayout(sidebarCollapsed)
  const pageRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [collapseIntent, setCollapseIntent] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const frame = useRef(0)
  const active = state.tabs.find((tab) => tab.active)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const navigate = useNavigate()

  const max = browserMax(windowWidth, collapsed)
  const effective = Math.min(Math.max(width, BROWSER_MIN), max)

  useEffect(() => {
    if (!editing) setAddress(active?.url ?? '')
  }, [active?.url, editing])

  // The native view sits above the DOM. While dragging or while a floating layer is open we swap it
  // for a still frame of the page, so nothing is covered and nothing flashes blank.
  const wantHidden = overlays > 0 || dragging
  useEffect(() => {
    let cancelled = false
    if (wantHidden) {
      // hide promptly even if capturing is slow (e.g. mid page load); the still frame fills in when ready
      // (a drag has already hidden it and shows the primed frame)
      const timer = setTimeout(() => !cancelled && setHidden(true), dragging ? 0 : 250)
      void call('browser.capture')
        .catch(() => null)
        .then((img) => {
          if (cancelled) return
          clearTimeout(timer)
          setSnapshot(img)
          setHidden(true)
        })
    } else {
      setHidden(false)
    }
    return () => {
      cancelled = true
    }
  }, [wantHidden, dragging])

  // Keep the native WebContentsView glued to the placeholder element.
  useLayoutEffect(() => {
    const el = pageRef.current
    if (!el) return
    const report = () => {
      if (hidden) return void call('browser.setBounds', null)
      const r = el.getBoundingClientRect()
      void call('browser.setBounds', { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [hidden, effective])

  useEffect(() => () => void call('browser.setBounds', null), [])

  // A still frame taken while the pointer rests on the gutter, so a drag can hide the native view at
  // once: while it is up, it swallows pointer events and a quick drag would stop over the page.
  const primed = useRef<string | null>(null)
  const primeSnapshot = () => {
    void call('browser.capture')
      .catch(() => null)
      .then((img) => (primed.current = img))
  }
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    void call('browser.setBounds', null)
    setSnapshot(primed.current)
    setHidden(true)
    setDragging(true)
  }
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const raw = window.innerWidth - e.clientX - GUTTER / 2
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      setCollapseIntent(raw < BROWSER_MIN - COLLAPSE_SLACK)
      setWidth(Math.round(Math.min(Math.max(raw, BROWSER_MIN), max)))
    })
  }
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    cancelAnimationFrame(frame.current)
    setDragging(false)
    setCollapseIntent(false)
    // decide from the release position itself: the last move's frame may not have run yet
    const raw = window.innerWidth - e.clientX - GUTTER / 2
    if (raw < BROWSER_MIN - COLLAPSE_SLACK) setOpen(false)
    else setWidth(Math.round(Math.min(Math.max(raw, BROWSER_MIN), max)))
  }
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24
    if (e.key === 'ArrowLeft') setWidth(Math.min(effective + step, max))
    else if (e.key === 'ArrowRight') setWidth(Math.max(effective - step, BROWSER_MIN))
    else if (e.key === 'Home') setWidth(BROWSER_DEFAULT)
    else return
    e.preventDefault()
  }

  const toggleRecording = async () => {
    try {
      if (state.recording) {
        const macro = await call('macros.stopRecording')
        if (macro) {
          toast.success(t('已保存录制宏'), {
            description: t('{{v0}} 个步骤', { v0: macro.steps.length }),
            action: { label: t('编辑'), onClick: () => navigate(`/macros?id=${macro.id}`) },
          })
        } else toast(t('未录制到任何操作'))
      } else {
        await call('macros.startRecording')
      }
    } catch (e) {
      toast.error(t('录制失败'), { description: errorMessage(e) })
    }
  }

  return (
    <aside className="flex shrink-0 animate-fade-in" style={{ width: effective + GUTTER }}>
      {/* resize gutter: lives outside the native view so it always receives the pointer */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('调整浏览器宽度（双击恢复默认，拖到最窄以收起）')}
        aria-valuemin={BROWSER_MIN}
        aria-valuemax={max}
        aria-valuenow={effective}
        tabIndex={0}
        title={t('拖动调整宽度 · 双击恢复默认')}
        className="group relative flex w-[6px] shrink-0 cursor-col-resize justify-center bg-background outline-none"
        onPointerEnter={primeSnapshot}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onDoubleClick={() => setWidth(BROWSER_DEFAULT)}
        onKeyDown={onHandleKey}
      >
        <div
          className={cn(
            'h-full w-px bg-border transition-[width,background-color] duration-150 ease-[var(--ease)] group-hover:w-[2px] group-hover:bg-primary/60 group-focus-visible:w-[2px] group-focus-visible:bg-primary',
            dragging && 'w-[2px] bg-primary',
            collapseIntent && 'bg-danger',
          )}
        />
        <div
          className={cn(
            'pointer-events-none absolute top-1/2 h-8 w-[4px] -translate-y-1/2 rounded-full bg-subtle-foreground/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100',
            dragging && 'opacity-0',
          )}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-card">
        {/* tabs */}
        <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-border bg-sidebar px-1.5">
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => void call('browser.activate', tab.id)}
              className={cn(
                'interactive group flex h-7 max-w-44 min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs',
                tab.active ? 'border-border bg-card text-foreground' : 'border-transparent text-muted-foreground hover:bg-sidebar-active/60',
              )}
            >
              {tab.loading ? (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              ) : tab.favicon ? (
                <img src={tab.favicon} className="size-3 shrink-0" alt="" />
              ) : (
                <Globe className="size-3 shrink-0" />
              )}
              <span className="truncate">{tab.title}</span>
              {tab.agent ? (
                <Tooltip content={`${tab.agent.running ? t('Agent 正在使用') : t('由对话使用')}：${tab.agent.title}`}>
                  <span className={cn('size-1.5 shrink-0 rounded-full', tab.agent.running ? 'animate-pulse bg-brand' : 'bg-subtle-foreground/60')} />
                </Tooltip>
              ) : null}
              <button
                className="interactive ml-auto shrink-0 rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent"
                onClick={(e) => {
                  e.stopPropagation()
                  void call('browser.closeTab', tab.id)
                }}
                aria-label={t('关闭标签页')}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="icon-sm" className="mb-0.5 size-6" onClick={() => void call('browser.newTab')} aria-label={t('新建标签页')}>
            <Plus />
          </Button>
        </div>

        {/* toolbar */}
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button variant="ghost" size="icon-sm" disabled={!active?.canGoBack} onClick={() => void call('browser.back')} aria-label={t('后退')}>
            <ArrowLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={!active?.canGoForward} onClick={() => void call('browser.forward')} aria-label={t('前进')}>
            <ArrowRight />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void call('browser.reload')} aria-label={t('刷新')}>
            <RotateCw />
          </Button>
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              setEditing(false)
              ;(document.activeElement as HTMLElement)?.blur()
              void call('browser.navigate', address).catch((err) => toast.error(t('无法打开页面'), { description: errorMessage(err) }))
            }}
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onFocus={(e) => {
                setEditing(true)
                e.target.select()
              }}
              onBlur={() => setEditing(false)}
              placeholder={t('输入网址或搜索')}
              className="interactive h-7 w-full rounded-md border border-transparent bg-muted px-2.5 text-xs text-foreground outline-none placeholder:text-subtle-foreground hover:border-border focus:border-primary/50 focus:bg-card focus:ring-2 focus:ring-ring"
            />
          </form>
          <Tooltip content={t('在系统浏览器中打开')}>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!active?.url.startsWith('http')}
              onClick={() => active && void call('app.openExternal', active.url)}
              aria-label={t('在系统浏览器中打开')}
            >
              <ExternalLink />
            </Button>
          </Tooltip>
          <Tooltip content={state.recording ? t('停止录制并保存为宏') : t('录制操作为宏')}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleRecording}
              aria-label={t('录制')}
              className={cn(state.recording && 'text-danger hover:text-danger')}
            >
              {state.recording ? <Square className="fill-current" /> : <Circle />}
            </Button>
          </Tooltip>
          {devMode ? (
            <Tooltip content={t('打开页面开发者工具')}>
              <Button variant="ghost" size="icon-sm" onClick={() => void call('browser.openDevTools')} aria-label={t('开发者工具')}>
                <SquareTerminal />
              </Button>
            </Tooltip>
          ) : null}
        </div>

        {/* status strip */}
        {state.agentControlled || state.recording ? (
          <div
            className={cn(
              'flex h-8 shrink-0 animate-fade-in items-center gap-2 border-b border-border px-3 text-xs',
              state.recording ? 'bg-danger-soft text-danger' : 'bg-info-soft text-brand',
            )}
          >
            {state.recording ? (
              <>
                <span className="size-1.5 animate-pulse rounded-full bg-danger" />
                <span className="font-medium">{t('录制中 · {{v0}} 步', { v0: recordingSteps })}</span>
                <span className="truncate text-muted-foreground">{lastRecorded}</span>
              </>
            ) : (
              <>
                <Loader2 className="size-3 animate-spin" />
                <span className="font-medium">{t('Agent 正在操作')}</span>
                <Button variant="link" size="sm" className="ml-auto h-auto text-xs" onClick={() => void call('browser.takeOver')}>
                  <Hand className="size-3" />
                  {t('接管')}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {/* native view placeholder */}
        <div ref={pageRef} className="relative min-h-0 flex-1 overflow-hidden bg-white dark:bg-[#0e1626]">
          {hidden ? (
            snapshot ? (
              <img
                src={snapshot}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover object-left-top select-none"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{active?.title}</div>
            )
          ) : null}
          {collapseIntent ? (
            <div className="absolute inset-0 flex animate-fade-in items-center justify-center bg-background/70 text-sm font-medium text-muted-foreground backdrop-blur-[2px]">
              {t('松开以收起浏览器')}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
