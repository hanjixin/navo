import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  Brain,
  FolderOpen,
  Clapperboard,
  Code2,
  Cpu,
  ListChecks,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Plug,
  Puzzle,
  Server,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { BrowserMini } from '@/components/browser/browser-mini'
import { BrowserPanel } from '@/components/browser/browser-panel'
import { Logo, PRODUCT_NAME } from '@/components/brand/logo'
import { cn } from '@/lib/utils'
import { useBrowser } from '@/stores/browser'
import { useSettings } from '@/stores/settings'
import { SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED, sidebarCollapsed, useLayout, useWindowWidthTracker } from '@/stores/layout'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  dev?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '工作台',
    items: [
      { to: '/chat', label: '对话', icon: MessageSquare },
      { to: '/tasks', label: '任务', icon: ListChecks },
      { to: '/files', label: '文件', icon: FolderOpen },
    ],
  },
  {
    group: '能力',
    items: [
      { to: '/skills', label: 'Skill', icon: Sparkles },
      { to: '/connectors', label: '连接器', icon: Plug },
      { to: '/mcp', label: 'MCP', icon: Server },
      { to: '/memory', label: '记忆', icon: Brain },
    ],
  },
  {
    group: '自动化',
    items: [
      { to: '/plugins', label: '站点插件', icon: Puzzle },
      { to: '/macros', label: '录制宏', icon: Clapperboard },
    ],
  },
  {
    group: '系统',
    items: [
      { to: '/models', label: '模型', icon: Cpu },
      { to: '/dev', label: '开发者', icon: Code2, dev: true },
      { to: '/settings', label: '设置', icon: Settings },
    ],
  },
]

const ALL = NAV.flatMap((g) => g.items)

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.to}
      aria-label={item.label}
      className={({ isActive }) =>
        cn(
          'interactive flex h-8 items-center gap-2.5 overflow-hidden rounded-md text-sm whitespace-nowrap text-muted-foreground hover:bg-sidebar-active/60 hover:text-foreground',
          collapsed ? 'w-9 justify-center px-0' : 'px-2.5',
          isActive && 'bg-sidebar-active font-medium text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className={cn('size-4 shrink-0 stroke-[1.75]', isActive && 'text-brand')} />
          <span className={cn('transition-opacity duration-150', collapsed && 'sr-only')}>{item.label}</span>
        </>
      )}
    </NavLink>
  )
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  )
}

export function AppShell() {
  const devMode = useSettings((s) => s.settings?.devMode ?? false)
  const { open, setOpen, state, mini } = useBrowser()
  const collapsed = useLayout(sidebarCollapsed)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
  const setMainWidth = useLayout((s) => s.setMainWidth)
  const mainRef = useRef<HTMLElement>(null)
  const location = useLocation()
  const current = ALL.find((i) => location.pathname.startsWith(i.to))
  const isMac = window.api.platform === 'darwin'
  const mod = isMac ? '⌘' : 'Ctrl+'
  useWindowWidthTracker()

  // content width drives responsive decisions inside pages (e.g. the chat thread list)
  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setMainWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [setMainWidth])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleSidebar()
      } else if (e.key === '\\') {
        e.preventDefault()
        setOpen(!useBrowser.getState().open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, setOpen])

  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED

  return (
    <div className="flex h-full flex-col">
      {/* title bar */}
      <header className="drag flex h-11 shrink-0 items-center border-b border-border bg-sidebar">
        <div
          className={cn('flex shrink-0 items-center gap-2 overflow-hidden transition-[width] duration-200 ease-[var(--ease)]', isMac ? 'pl-[80px]' : 'pl-4')}
          style={{ width: Math.max(sidebarWidth, isMac ? 124 : 0) }}
        >
          <Logo />
          <span className={cn('text-sm font-semibold tracking-[-0.01em] whitespace-nowrap transition-opacity duration-150', collapsed && 'opacity-0')}>
            {PRODUCT_NAME}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1 px-2">
          <Tooltip content={`${collapsed ? '展开' : '收起'}侧边栏 ${mod}B`}>
            <Button variant="ghost" size="icon-sm" className="no-drag" onClick={toggleSidebar} aria-label="切换侧边栏" aria-expanded={!collapsed}>
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </Tooltip>
          <span className="truncate text-sm text-muted-foreground">{current?.label}</span>
        </div>
        <div className="no-drag flex items-center gap-1 px-3">
          {state.agentControlled ? (
            <button
              className="interactive mr-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => (open ? undefined : useBrowser.getState().setMini(!mini))}
              aria-label={open ? 'Agent 正在操作浏览器' : mini ? '隐藏浏览器小窗' : '显示浏览器小窗'}
            >
              <span className="size-1.5 animate-pulse rounded-full bg-brand" />
              <span className="hidden md:inline">Agent 正在操作浏览器</span>
            </button>
          ) : null}
          {state.recording ? (
            <span className="mr-2 flex items-center gap-1.5 text-xs whitespace-nowrap text-danger">
              <span className="size-1.5 animate-pulse rounded-full bg-danger" />
              录制中
            </span>
          ) : null}
          <Tooltip content={`${open ? '收起' : '打开'}浏览器 ${mod}\\`}>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(!open)} aria-label="切换浏览器面板" aria-expanded={open}>
              {open ? <PanelRightClose /> : <PanelRight />}
            </Button>
          </Tooltip>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <nav
          aria-label="主导航"
          className={cn(
            'flex shrink-0 flex-col gap-4 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar py-4 transition-[width,padding] duration-200 ease-[var(--ease)]',
            collapsed ? 'items-center px-2.5' : 'px-2.5',
          )}
          style={{ width: sidebarWidth }}
        >
          {NAV.map((g, gi) => {
            const items = g.items.filter((i) => !i.dev || devMode)
            return (
              <div key={g.group} className={cn(collapsed && 'flex flex-col items-center')}>
                {collapsed ? (
                  gi > 0 ? (
                    <div className="mb-3 h-px w-6 bg-border" />
                  ) : null
                ) : (
                  <div className="mb-1 px-2.5 text-[11px] font-medium tracking-wide whitespace-nowrap text-subtle-foreground">{g.group}</div>
                )}
                <div className="grid gap-px">
                  {items.map((i) => (
                    <NavItemLink key={i.to} item={i} collapsed={collapsed} />
                  ))}
                </div>
              </div>
            )
          })}
        </nav>

        <main ref={mainRef} className="relative min-w-0 flex-1 bg-background">
          <Outlet />
          {!open && mini ? <BrowserMini /> : null}
        </main>

        {open ? <BrowserPanel /> : null}
      </div>
    </div>
  )
}
