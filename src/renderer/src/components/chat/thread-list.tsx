import { FolderKanban, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import type { Thread } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { call } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { projectPath, threadPath } from '@/lib/routes'
import { useChat } from '@/stores/chat'
import { useProjects } from '@/stores/projects'
import { t } from '@shared/i18n'

export function ThreadList({ projectId, compact = false }: { projectId?: string | null; compact?: boolean }) {
  const { threads, threadsError, select, loadThreads, views } = useChat()
  const { threadId: activeId } = useParams<{ threadId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { projects, load: loadProjects } = useProjects()
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<Thread | null>(null)
  const [moving, setMoving] = useState<Thread | null>(null)
  const [moveProject, setMoveProject] = useState('__none__')
  const [title, setTitle] = useState('')
  useEffect(() => {
    void loadProjects()
    void loadThreads()
  }, [loadProjects, loadThreads])
  const filtered = useMemo(
    () =>
      (threads ?? []).filter((item) => {
        const matchesProject = projectId === undefined || item.projectId === projectId
        return matchesProject && item.title.toLowerCase().includes(q.toLowerCase())
      }),
    [threads, q, projectId],
  )

  const remove = async (item: Thread) => {
    try {
      await call('threads.delete', item.id)
      if (activeId === item.id) {
        select(null)
        navigate(item.projectId ? projectPath(item.projectId) : '/chat', { replace: true })
      }
      await loadThreads()
    } catch (e) {
      toast.error(t('删除失败'), { description: errorMessage(e) })
    }
  }

  return (
    <div className={cn('flex min-h-0 animate-fade-in flex-col', compact ? 'min-h-0 w-full flex-1' : 'w-60 shrink-0 border-r border-border')}>
      <div className="grid gap-2 p-3">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('搜索对话')} className="h-7 pl-7 text-xs" />
          </div>
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={() => {
              select(null)
              navigate(projectId ? projectPath(projectId) : '/chat')
              requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
            }}
            aria-label={t('新建对话')}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {threadsError && !threads ? (
          <ErrorState error={threadsError} onRetry={loadThreads} compact className="mx-1" />
        ) : !threads ? (
          <div className="grid gap-2 px-2 pt-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : !filtered.length ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">{q ? t('没有匹配的对话') : t('还没有对话')}</p>
        ) : (
          <div className="grid gap-px">
            {filtered.map((item) => {
              const running = views[item.id]?.running
              return (
                <div
                  key={item.id}
                  className={cn(
                    'interactive group flex h-9 cursor-default items-center gap-2 rounded-md pr-1 pl-2.5 text-sm',
                    activeId === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" /> : null}
                  <Link to={threadPath(item)} className="min-w-0 flex-1 truncate py-2" aria-current={activeId === item.id ? 'page' : undefined}>
                    {item.title}
                  </Link>
                  {views[item.id]?.interrupt ? (
                    <span className="text-[11px] text-warning">{t('等待确认')}</span>
                  ) : views[item.id]?.error ? (
                    <span className="text-[11px] text-danger">{t('运行失败')}</span>
                  ) : null}
                  <span className="shrink-0 text-[11px] text-subtle-foreground group-hover:hidden">{timeAgo(item.updatedAt)}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <button
                        className="interactive hidden rounded-sm p-1 text-muted-foreground group-hover:block hover:bg-card data-[state=open]:block"
                        aria-label={t('更多')}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        onSelect={() => {
                          setTitle(item.title)
                          setRenaming(item)
                        }}
                      >
                        <Pencil />
                        {t('重命名')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setMoveProject(item.projectId ?? '__none__')
                          setMoving(item)
                        }}
                      >
                        <FolderKanban />
                        {t('移动到项目')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger onSelect={() => void remove(item)}>
                        <Trash2 />
                        {t('删除')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        {renaming ? (
          <DialogContent
            title={t('重命名对话')}
            className="w-[400px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setRenaming(null)}>
                  {t('取消')}
                </Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    try {
                      await call('threads.rename', renaming.id, title)
                      setRenaming(null)
                      void loadThreads()
                    } catch (e) {
                      toast.error(t('保存失败'), { description: errorMessage(e) })
                    }
                  }}
                >
                  {t('保存')}
                </Button>
              </>
            }
          >
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={!!moving} onOpenChange={(o) => !o && setMoving(null)}>
        {moving ? (
          <DialogContent
            title={t('移动对话')}
            description={moving.title}
            className="w-[400px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setMoving(null)}>
                  {t('取消')}
                </Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    try {
                      const nextProject = moveProject === '__none__' ? null : moveProject
                      await call('threads.setProject', moving.id, nextProject)
                      useChat.setState((state) => ({
                        threads: state.threads?.map((thread) => (thread.id === moving.id ? { ...thread, projectId: nextProject } : thread)),
                      }))
                      if (activeId === moving.id) navigate(threadPath({ ...moving, projectId: nextProject }) + location.search, { replace: true })
                      setMoving(null)
                      await loadThreads()
                    } catch (e) {
                      toast.error(t('保存失败'), { description: errorMessage(e) })
                    }
                  }}
                >
                  {t('保存')}
                </Button>
              </>
            }
          >
            <Select
              value={moveProject}
              onChange={setMoveProject}
              options={[{ value: '__none__', label: t('未归属项目') }, ...(projects ?? []).map((p) => ({ value: p.id, label: p.name }))]}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}
