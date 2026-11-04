import { FileText, FolderOpen, MessageSquare, ArrowUpRight, PackageOpen } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { artifactScopeKey, useArtifacts } from '@/stores/artifacts'
import { useProjects } from '@/stores/projects'
import { currentSearchParams, projectPath } from '@/lib/routes'
import { formatFileSize } from '@/stores/files'
import { timeAgo } from '@/lib/utils'
import { ProjectFiles } from '@/components/projects/project-files'
import { t } from '@shared/i18n'

/** Project context stays visible alongside conversations instead of an idle browser. */
export function ProjectInspector({ projectId, mode = 'files' }: { projectId: string; mode?: 'files' | 'artifacts' }) {
  const project = useProjects((s) => s.projects?.find((p) => p.id === projectId))
  const scope = useMemo(() => ({ projectId }), [projectId])
  const state = useArtifacts((s) => s.queries[artifactScopeKey(scope)])
  const { load, watch } = useArtifacts()
  const [, setParams] = useSearchParams()
  useEffect(() => {
    if (mode !== 'artifacts') return
    const off = watch(scope)
    void load(scope)
    return off
  }, [scope, load, watch, mode])
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="project-inspector-content">
      <details className="shrink-0 border-b border-border px-4 py-2">
        <summary className="interactive flex cursor-pointer list-none items-center gap-2 rounded py-1.5 text-xs text-muted-foreground">
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{project?.name ?? t('项目')}</span>
          <span className="text-subtle-foreground">{t('项目资料')}</span>
        </summary>
        <p className="mt-2 max-h-28 overflow-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {project?.description || t('暂无项目说明')}
        </p>
        <div className="mt-3 mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <MessageSquare className="size-3.5" />
            {t('{{count}} 个对话', { count: project?.threadCount ?? 0 })}
          </span>
          <Link to={`${projectPath(projectId)}?tab=settings`} className="interactive rounded px-1.5 py-1 hover:bg-accent hover:text-foreground">
            {t('项目设置')}
          </Link>
        </div>
      </details>
      {mode === 'files' ? (
        <ProjectFiles projectId={projectId} workingDirectory={project?.workingDirectory} />
      ) : (
        <section className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <div className="mb-2 flex items-center justify-between px-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t('项目产物')}</h3>
            <Link
              to={`${projectPath(projectId)}?tab=artifacts`}
              className="interactive inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t('查看全部')}
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
          {state?.error ? (
            <ErrorState compact error={state.error} onRetry={() => void load(scope)} />
          ) : !state?.items ? (
            <ListSkeleton rows={3} />
          ) : !state.items.length ? (
            <EmptyState icon={PackageOpen} title={t('暂无产物')} description={t('对话生成和下载的文件会显示在这里。')} className="px-3 py-8" />
          ) : (
            <div className="grid gap-1">
              {state.items.slice(0, 16).map((file) => (
                <Button
                  key={file.id}
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                  aria-label={t('预览 {{v0}}', { v0: file.name })}
                  onClick={() =>
                    setParams(() => {
                      const next = currentSearchParams()
                      next.set('artifact', file.id)
                      next.delete('file')
                      next.delete('panel')
                      return next
                    })
                  }
                >
                  <FileText className="mt-0.5 shrink-0 self-start text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{file.name}</span>
                    <span className="mt-1 block truncate text-[11px] font-normal text-subtle-foreground">{file.threadTitle}</span>
                    <span className="mt-0.5 block text-[11px] font-normal text-subtle-foreground">
                      {formatFileSize(file.size)} · {timeAgo(file.at)}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
