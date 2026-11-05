import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, Plus, Pencil, Trash2, FolderOpen, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ErrorState, ListSkeleton } from '@/components/ui/states'
import { ProjectEditor, ProjectDeleteDialog } from '@/components/projects/project-dialogs'
import { ThreadList } from '@/components/chat/thread-list'
import { Composer } from '@/components/chat/composer'
import { ArtifactBrowser } from '@/components/artifacts/artifact-browser'
import { useAsync } from '@/hooks/use-async'
import { useProjects } from '@/stores/projects'
import { useChat } from '@/stores/chat'
import { useDraft } from '@/hooks/use-draft'
import { mainDraftScope, submitDraft } from '@/stores/drafts'
import { useModels } from '@/stores/models'
import { call } from '@/lib/ipc'
import { currentSearchParams, projectPath, threadPath } from '@/lib/routes'
import { cn, errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'threads'
  const revision = useProjects((s) => s.revision)
  const detail = useAsync(async () => ({ projectId, project: await call('projects.get', projectId!) }), [projectId, revision])
  const project = detail.data && detail.data.projectId === projectId ? detail.data.project : undefined
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [creating, setCreating] = useState(false)
  const draft = useDraft(mainDraftScope(projectId))
  const modelId = draft.data?.modelId ?? null
  const { activeModels: models, load: loadModels } = useModels()
  const noModels = models !== undefined && models.length === 0
  useEffect(() => {
    void loadModels()
  }, [loadModels])
  useEffect(() => {
    if (
      detail.data &&
      detail.data.projectId === projectId &&
      detail.data.project === null &&
      window.location.hash.slice(1).split('?')[0] === projectPath(projectId!)
    )
      navigate('/projects', { replace: true })
  }, [detail.data, projectId, navigate])
  const createThread = async () => {
    if (creating || !projectId) return
    setCreating(true)
    try {
      const thread = await useChat.getState().newThread(modelId, projectId)
      navigate(threadPath(thread))
    } catch (e) {
      toast.error(t('创建失败'), { description: errorMessage(e) })
    } finally {
      setCreating(false)
    }
  }
  if (detail.error && !project)
    return (
      <div className="h-full overflow-y-auto p-5">
        <ErrorState error={detail.error} onRetry={detail.reload} />
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/projects')}>
          {t('返回项目')}
        </Button>
      </div>
    )
  if (!project)
    return (
      <div className="h-full overflow-y-auto p-5">
        <ListSkeleton />
      </div>
    )
  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="project-home">
      <header className="flex min-h-14 shrink-0 items-center gap-2 px-4 py-2 @3xl:px-6">
        <Tooltip content={t('全部项目')}>
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/projects')} aria-label={t('全部项目')}>
            <ArrowLeft />
          </Button>
        </Tooltip>
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={project.name}>
          {project.name}
        </h1>
        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" loading={creating} onClick={() => void createThread()}>
          <Plus />
          {t('新建对话')}
        </Button>
      </header>
      {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} compact className="mx-5 mb-3 shrink-0" /> : null}
      <div className="flex shrink-0 gap-1 border-b border-border px-5 pb-2 @3xl:px-7" role="tablist" aria-label={t('项目')}>
        {[
          { id: 'threads', label: t('对话') },
          { id: 'artifacts', label: t('Artifacts') },
          { id: 'settings', label: t('项目设置') },
        ].map((item) => (
          <Button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            variant="ghost"
            className={cn(tab === item.id && 'bg-accent')}
            onClick={() => {
              const next = currentSearchParams()
              if (item.id === 'threads') next.delete('tab')
              else next.set('tab', item.id)
              setParams(next)
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {tab === 'artifacts' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-5 @3xl:px-7">
          <ArtifactBrowser projectId={project.id} />
        </div>
      ) : tab === 'settings' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5 @3xl:px-7">
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium">{t('工作目录')}</h2>
            <p className="mt-2 mb-5 font-mono text-sm break-all text-muted-foreground">{project.workingDirectory ?? t('默认 Navo 工作区')}</p>
            <h2 className="font-medium">{t('项目说明')}</h2>
            <p className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">{project.description || t('暂无项目说明')}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil />
                {t('编辑项目')}
              </Button>
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 />
                {t('删除项目')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {project.threads.length ? (
            <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pt-6 @3xl:px-6" aria-label={t('最近对话')}>
              <div className="mb-2 flex items-center justify-between gap-3 px-3">
                <h2 className="text-sm font-medium">{t('最近对话')}</h2>
                <span className="text-xs text-subtle-foreground">{t('{{count}} 个对话', { count: project.threadCount })}</span>
              </div>
              <ThreadList projectId={project.id} compact />
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 overflow-y-auto px-6" data-testid="project-welcome">
              <div className="m-auto flex w-full max-w-2xl flex-col items-center py-8 pb-14 text-center @3xl:pb-20">
                <SquareTerminal className="mb-7 size-12 stroke-[1.25] text-subtle-foreground/70" aria-hidden="true" />
                <h2 className="max-w-full text-2xl leading-relaxed font-medium tracking-tight break-words @3xl:text-3xl">
                  {t('我们在「{{name}}」中做些什么？', { name: project.name })}
                </h2>
                <p className="mt-3 text-sm text-muted-foreground">{t('描述目标，或添加文件开始。')}</p>
              </div>
            </section>
          )}
          <div className="shrink-0 px-4 pt-4 pb-5 @3xl:px-6 @3xl:pb-6" data-testid="project-composer">
            <div className="mx-auto w-full max-w-3xl">
              {noModels ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3">
                  <p className="text-sm text-muted-foreground">{t('没有已启用的模型，请前往模型页面启用')}</p>
                  <Button variant="secondary" size="sm" onClick={() => navigate('/models')}>
                    {t('管理模型')}
                  </Button>
                </div>
              ) : null}
              <div className="rounded-2xl border border-border/70 bg-muted/60 p-1.5">
                <div className="flex min-w-0 items-center px-2 py-2">
                  <Tooltip content={`${project.name} · ${project.workingDirectory ?? t('默认 Navo 工作区')}`} side="top">
                    <span
                      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
                      data-testid="project-context"
                    >
                      <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 truncate">{project.name}</span>
                    </span>
                  </Tooltip>
                </div>
                <Composer
                  draftScope={draft.scope}
                  onSend={async () => {
                    const receipt = await submitDraft(draft.scope, { projectId, modelId })
                    await useChat.getState().loadThreads()
                    useChat.getState().select(receipt.threadId)
                    navigate(threadPath({ id: receipt.threadId, projectId: projectId! }))
                  }}
                  onStop={() => {}}
                  running={false}
                  modelId={modelId}
                  onModelChange={(modelId) => draft.patch({ modelId })}
                  disabled={draft.loading || creating || !models?.length}
                  disabledReason={noModels ? t('没有已启用的模型，请前往模型页面启用') : t('加载中')}
                  value={draft.data?.text ?? ''}
                  onValueChange={(text) => draft.patch({ text })}
                  placeholder={t('随心输入，或描述你想完成的任务…')}
                  minHeight={76}
                  className="rounded-xl border-transparent shadow-none"
                />
              </div>
            </div>
          </div>
        </>
      )}
      {editing ? <ProjectEditor project={project} onClose={() => setEditing(false)} onSaved={() => detail.reload()} /> : null}
      {deleting ? (
        <ProjectDeleteDialog
          project={project}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            if (window.location.hash.slice(1).split('?')[0] === projectPath(project.id)) navigate('/projects', { replace: true })
          }}
        />
      ) : null}
    </div>
  )
}
