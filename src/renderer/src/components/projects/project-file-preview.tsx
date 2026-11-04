import { ArrowLeft, Copy, ChevronLeft, ChevronRight, FileText, FolderOpen, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { OutputPreview, ProjectFileEntry } from '@shared/types'
import { PreviewBody } from '@/components/outputs/outputs-dialog'
import { Button } from '@/components/ui/button'
import { ErrorState, ListSkeleton } from '@/components/ui/states'
import { call } from '@/lib/ipc'
import { currentSearchParams } from '@/lib/routes'
import { errorMessage } from '@/lib/utils'
import { useProjects } from '@/stores/projects'
import { t } from '@shared/i18n'
import { useProjectFileRefresh } from './use-project-file-refresh'

export function ProjectFilePreview({ projectId, path }: { projectId: string; path: string }) {
  const root = useProjects((s) => s.projects?.find((project) => project.id === projectId)?.workingDirectory)
  return <FilePreview key={JSON.stringify([projectId, root, path])} projectId={projectId} path={path} />
}

function FilePreview({ projectId, path }: { projectId: string; path: string }) {
  const [preview, setPreview] = useState<OutputPreview>()
  const [directoryRoot, setDirectoryRoot] = useState<string>()
  const [siblings, setSiblings] = useState<ProjectFileEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const active = useRef(false)
  const running = useRef(false)
  const pending = useRef(false)
  const generation = useRef({ value: 0 })
  const [, setParams] = useSearchParams()
  const parts = path.split('/')
  const parent = parts.slice(0, -1).join('/')
  const reload = useCallback(async () => {
    if (running.current) {
      pending.current = true
      return
    }
    running.current = true
    const current = ++generation.current.value
    setLoading(true)
    const [content, listing] = await Promise.allSettled([call('projectFiles.preview', projectId, path), call('projectFiles.list', projectId, parent, true)])
    if (!active.current || current !== generation.current.value) return
    if (content.status === 'fulfilled') {
      setPreview(content.value)
      setError(null)
    } else setError(errorMessage(content.reason))
    if (listing.status === 'fulfilled') setDirectoryRoot(listing.value.root)
    setSiblings(listing.status === 'fulfilled' ? listing.value.entries.filter((entry) => entry.kind === 'file') : [])
    setLoading(false)
    running.current = false
    if (pending.current) {
      pending.current = false
      void reload()
    }
  }, [projectId, path, parent])
  useEffect(() => {
    const requestGeneration = generation.current
    active.current = true
    void reload()
    return () => {
      active.current = false
      requestGeneration.value++
      running.current = false
      pending.current = false
    }
  }, [reload])
  useProjectFileRefresh(reload)
  const navigate = (file: string | null, folder = parent) => {
    setParams(() => {
      const next = currentSearchParams()
      next.delete('artifact')
      if (file) {
        next.set('file', file)
        next.delete('panel')
        next.delete('directory')
      } else {
        next.set('panel', 'project')
        if (folder) next.set('directory', folder)
        else next.delete('directory')
      }
      return next
    })
  }
  const index = siblings.findIndex((entry) => entry.path === path)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next = index >= 0 ? siblings[index + 1] : undefined
  return (
    <>
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="mr-auto" onClick={() => navigate(null)}>
            <ArrowLeft />
            {t('返回文件列表')}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('上一个文件')}
            title={previous?.name ?? t('上一个文件')}
            disabled={!previous}
            onClick={() => previous && navigate(previous.path)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('下一个文件')}
            title={next?.name ?? t('下一个文件')}
            disabled={!next}
            onClick={() => next && navigate(next.path)}
          >
            <ChevronRight />
          </Button>
        </div>
        <nav aria-label={t('文件路径')} className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button className="interactive rounded hover:text-foreground" onClick={() => navigate(null, '')}>
            {t('项目文件')}
          </button>
          {parts.map((part, index) => (
            <span key={index} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3 shrink-0" />
              {index < parts.length - 1 ? (
                <button className="interactive truncate rounded hover:text-foreground" onClick={() => navigate(null, parts.slice(0, index + 1).join('/'))}>
                  {part}
                </button>
              ) : (
                <span className="break-all text-foreground">{part}</span>
              )}
            </span>
          ))}
        </nav>
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="mr-auto min-w-0 flex-1 truncate text-sm font-medium" title={path}>
          {parts.at(-1)}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label={t('刷新文件预览')} title={t('刷新文件预览')} disabled={loading} onClick={() => void reload()}>
          <RotateCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('复制路径')}
          title={t('复制路径')}
          onClick={() =>
            void navigator.clipboard.writeText(directoryRoot ? `${directoryRoot.replace(/[\\/]$/, '')}/${path}` : path).then(
              () => toast.success(t('已复制')),
              (e) => toast.error(t('操作失败'), { description: errorMessage(e) }),
            )
          }
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('在文件夹中显示')}
          title={t('在文件夹中显示')}
          onClick={() => void call('projectFiles.reveal', projectId, path).catch((e) => toast.error(t('操作失败'), { description: errorMessage(e) }))}
        >
          <FolderOpen />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="project-file-preview" aria-busy={loading}>
        {error ? (
          <ErrorState className="m-4" error={error} onRetry={() => void reload()} />
        ) : !preview ? (
          <ListSkeleton className="m-4" rows={3} />
        ) : (
          <>
            <PreviewBody p={preview} />
            {(preview.kind === 'text' || preview.kind === 'json') && preview.truncated ? (
              <p className="px-4 py-2 text-xs text-muted-foreground">{t('（文件较长，只显示了开头）')}</p>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}
