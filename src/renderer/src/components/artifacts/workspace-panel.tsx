import { FileBox, Globe, MessageSquare, X, FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { BrowserPanel } from '@/components/browser/browser-panel'
import { ProjectInspector } from './project-inspector'
import { ProjectFilePreview } from '@/components/projects/project-file-preview'
import { useProjects } from '@/stores/projects'
import { Preview } from '@/components/outputs/outputs-dialog'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { call, on } from '@/lib/ipc'
import { currentSearchParams, threadPath } from '@/lib/routes'
import { useBrowser } from '@/stores/browser'
import { MAIN_MIN, WORKSPACE_DEFAULT, WORKSPACE_MIN, useLayout } from '@/stores/layout'
import { useWorkspacePanel } from '@/hooks/use-workspace-panel'
import { useOverlayStore } from '@/stores/overlay'
import { t } from '@shared/i18n'

function ArtifactContent({ id }: { id: string }) {
  const artifact = useAsync(() => call('artifacts.get', id), [id])
  const reload = artifact.reload
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        reload()
      }, 50)
    }
    const offs = [on('outputs.changed', refresh), on('artifacts.changed', refresh)]
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      offs.forEach((off) => off())
      window.removeEventListener('focus', refresh)
    }
  }, [reload])
  if (artifact.error) return <ErrorState error={artifact.error} onRetry={artifact.reload} className="m-4" />
  if (artifact.data === undefined) return <ListSkeleton className="m-4" />
  if (!artifact.data) return <EmptyState icon={FileBox} title={t('产物不存在')} description={t('来源对话可能已被删除。')} />
  const file = artifact.data
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{file.projectName ?? t('未归属项目')}</span>
        <Link
          to={threadPath({ id: file.threadId, projectId: file.projectId })}
          className="interactive inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-accent"
          aria-label={t('打开来源对话')}
        >
          <MessageSquare className="size-3.5 shrink-0" />
          <span className="truncate">{file.threadTitle}</span>
        </Link>
      </div>
      <Preview file={file} artifact />
    </>
  )
}

/** One resizable workspace for local files, artifacts and the browser. */
export function WorkspacePanel() {
  const [, setParams] = useSearchParams()
  const { projectId, hasProject, artifactId: id, file, selected, visible, overlay, available, sidebarWidth, context, close } = useWorkspacePanel()
  const workingDirectory = useProjects((s) => s.projects?.find((p) => p.id === projectId)?.workingDirectory)
  const state = useBrowser((s) => s.state)
  const width = useLayout((s) => s.workspaceWidth)
  const setWidth = useLayout((s) => s.setWorkspaceWidth)
  const max = Math.max(WORKSPACE_MIN, available - MAIN_MIN)
  const effectiveWidth = Math.min(Math.max(Number.isFinite(width) ? width : WORKSPACE_DEFAULT, WORKSPACE_MIN), max)
  const panelRef = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const lastView = useRef(selected)
  lastView.current = selected
  useEffect(() => {
    if (!visible || !context) return
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape' || useOverlayStore.getState().count > 0) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [visible, context, close])
  useEffect(() => {
    if (visible && overlay && context) panelRef.current?.focus()
  }, [visible, overlay, context, selected, file, id])
  const select = (value: 'project' | 'artifacts' | 'browser') => {
    const next = currentSearchParams()
    if (value === 'browser') {
      useBrowser.getState().setOpen(true)
      next.set('panel', value)
    } else if (value === 'project' && file) next.delete('panel')
    else if (value === 'artifacts' && id) {
      next.delete('file')
      next.delete('panel')
    } else next.set('panel', value)
    setParams(next, { replace: true })
  }
  if (!visible) return null
  if (!context && selected === 'browser') return <BrowserPanel />
  const title = selected === 'artifact' ? t('产物预览') : selected === 'file' ? t('文件预览') : selected === 'browser' ? t('浏览器') : t('工作区面板')
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      aria-label={title}
      data-testid={selected === 'artifact' ? 'artifact-panel' : selected === 'file' ? 'project-file-panel' : 'project-inspector'}
      className={
        overlay
          ? 'absolute inset-y-0 right-0 z-30 flex min-w-0 border-l border-border bg-card shadow-float outline-none'
          : 'flex min-w-0 shrink-0 bg-card outline-none'
      }
      style={overlay ? { left: sidebarWidth } : { width: effectiveWidth }}
      onKeyDown={(event) => {
        if (!overlay || event.key !== 'Tab' || lastView.current === 'browser' || useOverlayStore.getState().count > 0) return
        const elements = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0)
        const first = elements[0]
        const last = elements.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      {!overlay ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('调整工作区宽度')}
          aria-valuemin={WORKSPACE_MIN}
          aria-valuemax={max}
          aria-valuenow={effectiveWidth}
          tabIndex={0}
          className="group flex w-1.5 shrink-0 cursor-col-resize justify-center bg-background outline-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (dragging) setWidth(Math.round(Math.min(Math.max(window.innerWidth - event.clientX, WORKSPACE_MIN), max)))
          }}
          onPointerUp={(event) => {
            if (!dragging) return
            event.currentTarget.releasePointerCapture(event.pointerId)
            setDragging(false)
          }}
          onPointerCancel={() => setDragging(false)}
          onDoubleClick={() => setWidth(WORKSPACE_DEFAULT)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setWidth(Math.min(effectiveWidth + 24, max))
            else if (event.key === 'ArrowRight') setWidth(Math.max(effectiveWidth - 24, WORKSPACE_MIN))
            else if (event.key === 'Home') setWidth(WORKSPACE_DEFAULT)
            else return
            event.preventDefault()
          }}
        >
          <div className="h-full w-px bg-border group-hover:bg-brand group-focus-visible:bg-brand" />
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-11 shrink-0 items-center gap-0.5 border-b border-border bg-sidebar px-2 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label={t('工作区面板')}>
            {hasProject ? (
              <Button
                size="sm"
                role="tab"
                aria-selected={selected === 'project' || selected === 'file'}
                variant={selected === 'project' || selected === 'file' ? 'secondary' : 'ghost'}
                onClick={() => select('project')}
              >
                <FolderOpen />
                {t('文件')}
              </Button>
            ) : null}
            {hasProject || id ? (
              <Button
                size="sm"
                role="tab"
                aria-selected={selected === 'artifacts' || selected === 'artifact'}
                variant={selected === 'artifacts' || selected === 'artifact' ? 'secondary' : 'ghost'}
                onClick={() => select('artifacts')}
              >
                <FileBox />
                {t('产物')}
              </Button>
            ) : null}
            <Button
              size="sm"
              role="tab"
              aria-selected={selected === 'browser'}
              variant={selected === 'browser' ? 'secondary' : 'ghost'}
              onClick={() => select('browser')}
            >
              <Globe />
              {t('浏览器')}
              {state.agentControlled ? <span className="size-1.5 rounded-full bg-brand" /> : null}
            </Button>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={close} aria-label={t('收起工作区面板')}>
            <X />
          </Button>
        </div>
        {selected === 'browser' ? (
          <BrowserPanel embedded resizing={dragging} />
        ) : selected === 'project' || selected === 'artifacts' ? (
          <ProjectInspector key={projectId} projectId={projectId!} mode={selected === 'artifacts' ? 'artifacts' : 'files'} />
        ) : selected === 'file' ? (
          <ProjectFilePreview key={JSON.stringify([projectId, workingDirectory, file])} projectId={projectId!} path={file!} />
        ) : (
          <ArtifactContent key={id} id={id!} />
        )}
      </div>
    </aside>
  )
}
