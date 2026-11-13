import type { OutputKind } from '@shared/types'
import { FileBox, FolderOpen, MessageSquare, PackageOpen, RotateCw, Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { Badge } from '@/components/ui/badge'
import { artifactScopeKey, useArtifacts, type ArtifactScope } from '@/stores/artifacts'
import { formatFileSize } from '@/stores/files'
import { cn, timeAgo } from '@/lib/utils'
import { currentSearchParams, projectPath, threadPath } from '@/lib/routes'
import { t } from '@shared/i18n'

const scrollPositions = new Map<string, number>()

/** Shared list for a project, a conversation or the global artifact library. Preview lives in the app's right panel. */
export function ArtifactBrowser({ projectId, threadId }: ArtifactScope) {
  const [params, setParams] = useSearchParams()
  const { pathname } = useLocation()
  const query = params.get('q') ?? ''
  const kind = params.get('kind') ?? 'all'
  const scope = useMemo(() => ({ projectId, threadId, q: query, kind: kind === 'all' ? undefined : (kind as OutputKind) }), [projectId, threadId, query, kind])
  const key = artifactScopeKey(scope)
  const state = useArtifacts((s) => s.queries[key])
  const { load, watch } = useArtifacts()
  const selected = params.get('artifact')
  const listRef = useRef<HTMLDivElement>(null)
  const scrollKey = `${pathname}:${key}:${query}:${kind}`

  useEffect(() => {
    const unwatch = watch(scope)
    void load(scope)
    return unwatch
  }, [load, watch, scope])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = scrollPositions.get(scrollKey) ?? 0
  }, [scrollKey, state?.items])

  const change = (name: string, value: string) => {
    setParams(
      () => {
        const next = currentSearchParams()
        if (!value || value === 'all') next.delete(name)
        else next.set(name, value)
        return next
      },
      { replace: true },
    )
  }
  const items = state?.items ?? []

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" data-testid="artifact-browser">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <Input aria-label={t('搜索产物')} value={query} onChange={(e) => change('q', e.target.value)} placeholder={t('搜索产物')} className="pl-8" />
        </div>
        <Select
          value={kind}
          onChange={(v) => change('kind', v)}
          className="w-36"
          options={[
            { value: 'all', label: t('所有类型') },
            { value: 'markdown', label: 'Markdown' },
            { value: 'table', label: t('表格') },
            { value: 'document', label: t('文档') },
            { value: 'pdf', label: 'PDF' },
            { value: 'image', label: t('图片') },
            { value: 'html', label: 'HTML' },
            { value: 'json', label: 'JSON' },
            { value: 'text', label: t('文本') },
            { value: 'other', label: t('其他') },
          ]}
        />
        <Button variant="ghost" size="icon-sm" disabled={state?.loading} onClick={() => void load(scope)} aria-label={t('刷新产物')}>
          <RotateCw />
        </Button>
      </div>
      {state?.error ? (
        <ErrorState error={state.error} onRetry={() => void load(scope)} />
      ) : !state?.items ? (
        <ListSkeleton rows={4} />
      ) : !items.length ? (
        <EmptyState
          icon={PackageOpen}
          title={query || kind !== 'all' ? t('没有匹配的产物') : t('暂无产物')}
          description={t('对话生成和下载的文件会显示在这里。')}
        />
      ) : (
        <div
          ref={listRef}
          className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card"
          onScroll={(e) => scrollPositions.set(scrollKey, e.currentTarget.scrollTop)}
          data-testid="artifact-list"
        >
          {items.map((artifact) => (
            <div
              key={artifact.id}
              className={cn('group flex min-w-0 flex-wrap items-center gap-1 border-b border-border last:border-0', selected === artifact.id && 'bg-accent')}
            >
              <button
                className="interactive flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left hover:bg-accent/50"
                aria-label={t('预览 {{v0}}', { v0: artifact.name })}
                onClick={() =>
                  setParams(() => {
                    const next = currentSearchParams()
                    next.set('artifact', artifact.id)
                    next.delete('file')
                    next.delete('panel')
                    return next
                  })
                }
              >
                <FileBox className="mt-1 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm font-medium', artifact.missing && 'line-through')}>{artifact.name}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {formatFileSize(artifact.size)} · {timeAgo(artifact.at)}
                  </span>
                  {projectId === undefined && artifact.projectId ? (
                    <Link
                      to={projectPath(artifact.projectId)}
                      className="interactive mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-subtle-foreground hover:text-foreground"
                      aria-label={t('打开所属项目')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <FolderOpen className="size-3 shrink-0" />
                      <span className="truncate">{artifact.projectName}</span>
                    </Link>
                  ) : projectId === undefined ? (
                    <span className="mt-1 block truncate text-xs text-subtle-foreground">{t('未归属项目')}</span>
                  ) : null}
                  <span className="mt-1 block truncate text-xs text-subtle-foreground">{artifact.threadTitle}</span>
                </span>
                {artifact.contentChanged ? (
                  <Badge variant="warning">{t('文件已变化')}</Badge>
                ) : artifact.missing ? (
                  <Badge variant="warning">{t('已移除')}</Badge>
                ) : artifact.unavailableReason === 'unreadable' ? (
                  <Badge variant="warning">{t('无法读取')}</Badge>
                ) : null}
              </button>
              <Link
                className="interactive mr-3 inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                to={threadPath({ id: artifact.threadId, projectId: artifact.projectId })}
                aria-label={t('打开来源对话')}
              >
                <MessageSquare className="size-3.5" />
                <span className="hidden @xl:inline">{t('来源对话')}</span>
              </Link>
            </div>
          ))}
          {state?.nextCursor ? (
            <Button className="m-3" loading={state.loading} onClick={() => void load(scope, true)}>
              {t('加载更多')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
