import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  FolderOpen,
  FolderKanban,
  FileBox,
  Clapperboard,
  Code2,
  BarChart3,
  Cpu,
  ListChecks,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Plug,
  Puzzle,
  Search,
  Server,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { BrowserMini } from '@/components/browser/browser-mini'
import { FlowDialog } from '@/components/flows/flow-dialog'
import { WorkspacePanel } from '@/components/artifacts/workspace-panel'
import { ProjectSidebar } from '@/components/projects/project-sidebar'
import { currentSearchParams, threadPath } from '@/lib/routes'
import { ApprovalCenter } from '@/components/chat/approval-center'
import { Logo, PRODUCT_NAME } from '@/components/brand/logo'
import { on } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useWorkspacePanel } from '@/hooks/use-workspace-panel'
import { useBrowser } from '@/stores/browser'
import { useSettings } from '@/stores/settings'
import { SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED, sidebarCollapsed, useLayout, useWindowWidthTracker } from '@/stores/layout'
import { t } from '@shared/i18n'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  dev?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: t('工作台'),
    items: [
      { to: '/chat', label: t('全部会话'), icon: MessageSquare },
      { to: '/tasks', label: t('任务'), icon: ListChecks },
      { to: '/files', label: t('文件'), icon: FolderOpen },
      { to: '/artifacts', label: t('Artifacts'), icon: FileBox },
    ],
  },
  {
    group: t('能力'),
    items: [
      { to: '/skills', label: 'Skill', icon: Sparkles },
      { to: '/connectors', label: t('连接器'), icon: Plug },
      { to: '/mcp', label: 'MCP', icon: Server },
      { to: '/memory', label: t('记忆'), icon: Brain },
    ],
  },
  {
    group: t('自动化'),
    items: [
      { to: '/plugins', label: t('站点插件'), icon: Puzzle },
      { to: '/macros', label: t('录制宏'), icon: Clapperboard },
    ],
  },
  {
    group: t('系统'),
    items: [
      { to: '/models', label: t('模型'), icon: Cpu },
      { to: '/usage', label: t('用量'), icon: BarChart3 },
      { to: '/dev', label: t('开发者'), icon: Code2, dev: true },
      { to: '/settings', label: t('设置'), icon: Settings },
    ],
  },
]

const ALL = [...NAV.flatMap((g) => g.items), { to: '/projects', label: t('项目'), icon: FolderKanban }]

function CommandPalette({ open, onOpenChange, devMode }: { open: boolean; onOpenChange: (open: boolean) => void; devMode: boolean }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ALL.filter((item) => !item.dev || devMode).filter((item) => !q || item.label.toLowerCase().includes(q) || item.to.includes(q))
  }, [devMode, query])

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const go = (to: string) => {
    onOpenChange(false)
    navigate(to)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('全局搜索')} description={t('输入页面名称或路径，快速跳转。')} className="w-[min(520px,calc(100vw-48px))]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索页面')} className="pl-8" />
        </div>
        <div className="mt-3 grid max-h-[45vh] gap-1 overflow-y-auto">
          {items.length ? (
            items.map((item) => (
              <button
                key={item.to}
                className="interactive flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => go(item.to)}
              >
                <item.icon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="font-mono text-xs text-subtle-foreground">{item.to}</span>
              </button>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('没有匹配的页面')}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.to === '/projects'}
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const workspace = useWorkspacePanel()
  const projectRoute = /^\/projects\/[^/]+/.test(location.pathname)
  const contextSelected = workspace.visible && workspace.selected !== 'browser'
  const toggleBrowser = useCallback(() => {
    if (workspace.visible) workspace.close()
    else workspace.restore()
  }, [workspace])
  const current = ALL.find((i) => location.pathname.startsWith(i.to))
  const isMac = window.api.platform === 'darwin'
  const mod = isMac ? '⌘' : 'Ctrl+'
  useWindowWidthTracker()

  useEffect(
    () =>
      on('browser.reveal', ({ open: reveal }) => {
        if (reveal) {
          setOpen(true)
          setParams(
            () => {
              const next = currentSearchParams()
              next.set('panel', 'browser')
              return next
            },
            { replace: true },
          )
        }
      }),
    [projectRoute, params, setOpen, setParams],
  )

  // content width drives responsive decisions inside pages (e.g. the chat thread list)
  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setMainWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [setMainWidth])

  // "continue in Navo" from the quick window
  useEffect(
    () =>
      on('quick.openThread', (id) => {
        void useChat
          .getState()
          .loadThreads()
          .then(() => {
            const thread = useChat.getState().threads?.find((thread) => thread.id === id)
            useChat.getState().select(id)
            navigate(thread ? threadPath(thread) : '/chat')
          })
      }),
    [navigate],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleSidebar()
      } else if (e.key === '\\') {
        e.preventDefault()
        toggleBrowser()
      } else if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, toggleBrowser])

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
          <Tooltip content={t('{{v0}}侧边栏 {{v1}}B', { v0: collapsed ? t('展开') : t('收起'), v1: mod })}>
            <Button variant="ghost" size="icon-sm" className="no-drag" onClick={toggleSidebar} aria-label={t('切换侧边栏')} aria-expanded={!collapsed}>
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </Tooltip>
          <span className="truncate text-sm text-muted-foreground">{current?.label}</span>
          <Button
            variant="ghost"
            size="sm"
            className="no-drag ml-2 hidden h-7 gap-1.5 px-2 text-xs text-muted-foreground lg:flex"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="size-3.5" />
            <span>{t('搜索')}</span>
            <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">{mod}K</kbd>
          </Button>
        </div>
        <div className="no-drag flex items-center gap-1 px-3">
          <ApprovalCenter />
          {state.agentControlled ? (
            <button
              className="interactive mr-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => (open ? undefined : useBrowser.getState().setMini(!mini))}
              aria-label={open ? t('Agent 正在操作浏览器') : mini ? t('隐藏浏览器小窗') : t('显示浏览器小窗')}
            >
              <span className="size-1.5 animate-pulse rounded-full bg-brand" />
              <span className="hidden md:inline">{t('Agent 正在操作浏览器')}</span>
            </button>
          ) : null}
          {state.recording ? (
            <span className="mr-2 flex items-center gap-1.5 text-xs whitespace-nowrap text-danger">
              <span className="size-1.5 animate-pulse rounded-full bg-danger" />
              {t('录制中')}
            </span>
          ) : null}
          <Tooltip
            content={
              workspace.context
                ? workspace.visible
                  ? t('收起工作区面板')
                  : t('打开工作区面板')
                : t('{{v0}}浏览器 {{v1}}\\', { v0: workspace.visible ? t('收起') : t('打开'), v1: mod })
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="toggle-workspace"
              onClick={toggleBrowser}
              aria-label={workspace.context ? (workspace.visible ? t('收起工作区面板') : t('打开工作区面板')) : t('切换浏览器面板')}
              aria-expanded={workspace.visible}
            >
              {workspace.visible ? <PanelRightClose /> : <PanelRight />}
            </Button>
          </Tooltip>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} devMode={devMode} />

      <div className="relative flex min-h-0 flex-1">
        {/* sidebar */}
        <nav
          aria-label={t('主导航')}
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
                {gi === 0 ? <ProjectSidebar collapsed={collapsed} /> : null}
              </div>
            )
          })}
        </nav>

        <main ref={mainRef} className="relative min-w-0 flex-1 bg-background">
          <Outlet />
          <FlowDialog />
          {!open && !contextSelected && mini ? <BrowserMini /> : null}
        </main>

        <WorkspacePanel />
      </div>
    </div>
  )
}
