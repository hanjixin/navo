import { FolderKanban, Plus, Search, ChevronRight, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Page, PageHeader } from '@/components/layout/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import type { Project } from '@shared/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ProjectEditor, ProjectDeleteDialog } from '@/components/projects/project-dialogs'
import { useProjects } from '@/stores/projects'
import { timeAgo } from '@/lib/utils'
import { projectPath } from '@/lib/routes'
import { t } from '@shared/i18n'

export function ProjectsPage() {
  const { projects, error, load } = useProjects()
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const navigate = useNavigate()
  useEffect(() => {
    void load()
  }, [load])
  const matches = projects?.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <Page>
      <PageHeader
        title={t('项目')}
        description={t('进入项目，继续对话或查看产物。')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            {t('新建项目')}
          </Button>
        }
      />
      <div className="relative mb-5">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索项目')} className="pl-9" />
      </div>
      {error ? <ErrorState error={error} onRetry={() => void load()} className="mb-4" /> : null}
      {!projects ? (
        <ListSkeleton />
      ) : !matches?.length ? (
        <EmptyState
          icon={FolderKanban}
          title={query ? t('没有匹配的项目') : t('暂无项目')}
          action={!query ? <Button onClick={() => setCreating(true)}>{t('创建项目')}</Button> : undefined}
        />
      ) : (
        <div className="grid gap-3">
          {matches.map((project) => (
            <div key={project.id} className="flex min-w-0 items-center rounded-xl border border-border bg-card pr-3">
              <button
                onClick={() => navigate(projectPath(project.id))}
                className="interactive flex min-w-0 flex-1 items-center gap-4 rounded-xl px-5 py-4 text-left hover:bg-accent"
              >
                <FolderKanban className="size-6 shrink-0 text-brand" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{project.name}</span>
                  <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{project.description || t('暂无项目说明')}</span>
                  <span className="mt-1 block truncate font-mono text-xs text-muted-foreground" title={project.workingDirectory ?? t('默认 Navo 工作区')}>
                    {project.workingDirectory ?? t('默认 Navo 工作区')}
                  </span>
                  <span className="mt-2 block text-xs text-subtle-foreground">
                    {t('{{count}} 个对话', { count: project.threadCount })} · {t('{{count}} 个产物', { count: project.artifactCount })} ·{' '}
                    {timeAgo(project.lastActivityAt)}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`${t('更多')} · ${project.name}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing(project)}>
                    <Pencil />
                    {t('编辑项目')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => setDeleting(project)}>
                    <Trash2 />
                    {t('删除项目')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}
      {editing ? <ProjectEditor project={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <ProjectDeleteDialog project={deleting} onClose={() => setDeleting(null)} onDeleted={() => setDeleting(null)} /> : null}
      {creating ? <ProjectEditor onClose={() => setCreating(false)} onSaved={(project) => navigate(projectPath(project.id))} /> : null}
    </Page>
  )
}
