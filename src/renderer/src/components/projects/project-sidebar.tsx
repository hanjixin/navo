import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { ChevronDown, ChevronRight, FolderKanban, Plus, CircleAlert, Loader2 } from 'lucide-react'
import { useProjects } from '@/stores/projects'
import { useChat } from '@/stores/chat'
import { ProjectEditor } from './project-dialogs'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { projectPath, threadPath } from '@/lib/routes'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

export function ProjectSidebar({ collapsed }: { collapsed: boolean }) {
  const { projects, load } = useProjects()
  const { threads, views, loadThreads } = useChat()
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('projects.expanded') ?? '[]')
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  useEffect(() => {
    try {
      localStorage.setItem('projects.expanded', JSON.stringify([...expanded]))
    } catch {
      /* storage unavailable */
    }
  }, [expanded])
  useEffect(() => {
    void load()
    void loadThreads()
  }, [load, loadThreads])
  return (
    <div className="min-w-0">
      <div className={cn('mt-3 mb-1 flex items-center justify-between px-1', collapsed && 'justify-center px-0')}>
        <Tooltip content={t('全部项目')} side="right">
          <NavLink
            to="/projects"
            end
            aria-label={t('全部项目')}
            className={({ isActive }) =>
              cn(
                'interactive flex min-w-0 items-center gap-2 rounded-md text-muted-foreground hover:bg-sidebar-active hover:text-foreground',
                collapsed ? 'size-9 justify-center' : 'flex-1 px-1.5 py-1.5 text-xs font-medium',
                isActive && 'bg-sidebar-active text-foreground',
              )
            }
          >
            {collapsed ? <FolderKanban className="size-4" /> : t('项目')}
          </NavLink>
        </Tooltip>
        {!collapsed ? (
          <Tooltip content={t('新建项目')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('新建项目')} onClick={() => setCreating(true)}>
              <Plus />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {!collapsed &&
        projects?.slice(0, 8).map((project) => {
          const projectThreads = (threads ?? []).filter((thread) => thread.projectId === project.id)
          const waiting = projectThreads.filter((thread) => !!views[thread.id]?.interrupt).length
          const running = projectThreads.filter((thread) => views[thread.id]?.running).length
          const open = expanded.has(project.id)
          return (
            <div key={project.id} className="min-w-0">
              <div className="flex min-w-0 items-center">
                {!collapsed ? (
                  <button
                    className="interactive shrink-0 rounded p-1 text-subtle-foreground hover:bg-accent"
                    aria-label={`${open ? t('收起') : t('展开')} ${project.name}`}
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((old) => {
                        const next = new Set(old)
                        if (next.has(project.id)) next.delete(project.id)
                        else next.add(project.id)
                        return next
                      })
                    }
                  >
                    {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  </button>
                ) : null}
                <NavLink
                  to={projectPath(project.id)}
                  title={project.name}
                  aria-label={project.name}
                  className={({ isActive }) =>
                    cn(
                      'interactive flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-active',
                      isActive && 'bg-sidebar-active text-foreground',
                      collapsed && 'justify-center',
                    )
                  }
                >
                  <FolderKanban className="size-4 shrink-0" />
                  {!collapsed ? (
                    <>
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      {waiting ? (
                        <span title={t('等待处理')} className="flex items-center gap-1 text-xs text-warning">
                          <CircleAlert className="size-3" />
                          {waiting}
                        </span>
                      ) : running ? (
                        <span title={t('运行中')} className="flex items-center gap-1 text-xs text-brand">
                          <Loader2 className="size-3 animate-spin" />
                          {running}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </NavLink>
              </div>
              {open && !collapsed ? (
                <div className="ml-5 grid gap-px border-l border-border pl-2">
                  {projectThreads.slice(0, 5).map((thread) => (
                    <NavLink
                      key={thread.id}
                      to={threadPath(thread)}
                      className={({ isActive }) =>
                        cn(
                          'interactive flex min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-active',
                          isActive && 'bg-sidebar-active text-foreground',
                        )
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      {views[thread.id]?.interrupt ? (
                        <CircleAlert className="size-3 shrink-0 text-warning" />
                      ) : views[thread.id]?.running ? (
                        <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
                      ) : views[thread.id]?.error ? (
                        <CircleAlert className="size-3 shrink-0 text-danger" />
                      ) : null}
                    </NavLink>
                  ))}
                  {!projectThreads.length ? <span className="px-2 py-2 text-xs text-subtle-foreground">{t('还没有对话')}</span> : null}
                </div>
              ) : null}
            </div>
          )
        })}
      {creating ? <ProjectEditor onClose={() => setCreating(false)} onSaved={(project) => navigate(projectPath(project.id))} /> : null}
    </div>
  )
}
