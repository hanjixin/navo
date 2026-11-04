import { Copy, ChevronDown, ChevronRight, File, Folder, FolderOpen, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/states'
import { useProjects } from '@/stores/projects'
import { useProjectFileRefresh } from './use-project-file-refresh'
import { call } from '@/lib/ipc'
import { currentSearchParams } from '@/lib/routes'
import { cn, errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

type Listing = Awaited<ReturnType<typeof listDirectory>>
const listDirectory = (projectId: string, path: string, showHidden: boolean) => call('projectFiles.list', projectId, path, showHidden)
interface DirectoryState {
  data?: Listing
  loading: boolean
  error: string | null
  version: number
}
interface TreeState {
  expanded: Set<string>
  directories: Map<string, DirectoryState>
  showHidden: boolean
  scrollTop: number
}
const trees = new Map<string, TreeState>()

export function ProjectFiles({ projectId, workingDirectory }: { projectId: string; workingDirectory?: string | null }) {
  const cacheKey = JSON.stringify([projectId, workingDirectory ?? null])
  return <FileTree key={cacheKey} cacheKey={cacheKey} projectId={projectId} workingDirectory={workingDirectory} />
}

function FileTree({ cacheKey, projectId, workingDirectory }: { cacheKey: string; projectId: string; workingDirectory?: string | null }) {
  const [tree] = useState(() => {
    const existing = trees.get(cacheKey)
    if (existing) return existing
    const next: TreeState = { expanded: new Set(), directories: new Map(), showHidden: false, scrollTop: 0 }
    trees.set(cacheKey, next)
    return next
  })
  const [, render] = useState(0)
  const mounted = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const [picking, setPicking] = useState(false)
  const pending = useRef(new Set<string>())
  const [params, setParams] = useSearchParams()
  const selected = params.get('file')
  const folder = params.get('directory')
  const update = useCallback(() => {
    if (mounted.current) render((n) => n + 1)
  }, [])
  const load = useCallback(
    async (path: string) => {
      const previous = tree.directories.get(path)
      if (previous?.loading) {
        pending.current.add(path)
        return
      }
      const version = (previous?.version ?? 0) + 1
      tree.directories.set(path, { data: previous?.data, loading: true, error: null, version })
      update()
      try {
        const data = await listDirectory(projectId, path, tree.showHidden)
        if (!mounted.current || tree.directories.get(path)?.version !== version) return
        tree.directories.set(path, { data, loading: false, error: null, version })
      } catch (e) {
        if (!mounted.current || tree.directories.get(path)?.version !== version) return
        tree.directories.set(path, { data: previous?.data, loading: false, error: errorMessage(e), version })
      }
      update()
      if (pending.current.delete(path) && mounted.current) void load(path)
    },
    [projectId, tree, update],
  )
  const refresh = useCallback(() => {
    const visible = (path: string) => {
      const parts = path.split('/')
      if (!tree.showHidden && parts.some((part) => part.startsWith('.'))) return false
      return parts.slice(0, -1).every((_, index) => tree.expanded.has(parts.slice(0, index + 1).join('/')))
    }
    void load('')
    for (const path of tree.expanded) if (visible(path)) void load(path)
  }, [tree, load])
  useEffect(() => {
    mounted.current = true
    const queued = pending.current
    refresh()
    if (scroller.current) scroller.current.scrollTop = tree.scrollTop
    return () => {
      mounted.current = false
      for (const [path, state] of tree.directories) tree.directories.set(path, { ...state, loading: false, version: state.version + 1 })
      queued.clear()
    }
  }, [refresh, tree])
  useEffect(() => {
    if (!folder) return
    const parts = folder.split('/')
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/')
      tree.expanded.add(path)
      void load(path)
    }
    update()
  }, [folder, tree, load, update])
  useProjectFileRefresh(refresh)
  const chooseDirectory = async () => {
    setPicking(true)
    try {
      const directory = await call('projects.pickDirectory')
      if (!mounted.current || !directory) return
      const project = useProjects.getState().projects?.find((item) => item.id === projectId) ?? (await call('projects.get', projectId))
      if (!mounted.current) return
      if (!project) throw new Error(t('项目不存在'))
      await useProjects.getState().save({ id: project.id, name: project.name, description: project.description, workingDirectory: directory })
    } catch (e) {
      if (mounted.current) toast.error(t('操作失败'), { description: errorMessage(e) })
    } finally {
      if (mounted.current) setPicking(false)
    }
  }
  const root = tree.directories.get('')?.data?.root ?? workingDirectory
  const toggleHidden = () => {
    tree.showHidden = !tree.showHidden
    for (const [path, state] of tree.directories) tree.directories.set(path, { version: state.version + 1, loading: false, error: null })
    refresh()
  }
  const toggle = (path: string) => {
    if (tree.expanded.has(path)) tree.expanded.delete(path)
    else {
      tree.expanded.add(path)
      void load(path)
    }
    update()
  }
  const directory = (path: string, depth = 0): React.ReactNode => {
    const state = tree.directories.get(path)
    if (state?.error) return <ErrorState compact className="my-1" error={state.error} onRetry={() => void load(path)} />
    if (!state?.data) return <p className="px-2 py-2 text-xs text-muted-foreground">{t('加载中')}</p>
    return (
      <>
        {state.data.entries.map((entry) => (
          <div key={entry.path}>
            <button
              className={cn(
                'interactive flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-accent',
                selected === entry.path && entry.kind === 'file' && 'bg-accent text-foreground',
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              aria-label={
                entry.kind === 'directory'
                  ? tree.expanded.has(entry.path)
                    ? t('收起文件夹 {{name}}', { name: entry.name })
                    : t('展开文件夹 {{name}}', { name: entry.name })
                  : t('查看文件 {{name}}', { name: entry.name })
              }
              aria-expanded={entry.kind === 'directory' ? tree.expanded.has(entry.path) : undefined}
              title={entry.path}
              onClick={() => {
                if (entry.kind === 'directory') toggle(entry.path)
                else
                  setParams(() => {
                    const next = currentSearchParams()
                    next.set('file', entry.path)
                    next.delete('artifact')
                    next.delete('panel')
                    next.delete('directory')
                    return next
                  })
              }}
            >
              {entry.kind === 'directory' ? (
                <>
                  {tree.expanded.has(entry.path) ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                  <Folder className="size-3.5 shrink-0" />
                </>
              ) : (
                <File className="ml-4 size-3.5 shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {entry.kind === 'directory' && tree.expanded.has(entry.path) ? directory(entry.path, depth + 1) : null}
          </div>
        ))}
        {!state.data.entries.length ? <p className="px-2 py-2 text-xs text-subtle-foreground">{t('此文件夹为空')}</p> : null}
        {state.data.truncated ? <p className="px-2 py-2 text-xs text-muted-foreground">{t('文件较多，仅显示部分内容。请在本地文件夹查看全部。')}</p> : null}
      </>
    )
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col px-2 py-4" data-testid="project-files">
      <div className="mb-2 flex items-center justify-between gap-1 px-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('项目文件')}</h3>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('复制路径')}
            title={t('复制路径')}
            disabled={!root}
            onClick={() =>
              root &&
              void navigator.clipboard.writeText(root).then(
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
            aria-label={t('打开工作目录')}
            title={t('打开工作目录')}
            onClick={() => void call('projectFiles.openDirectory', projectId).catch((e) => toast.error(t('操作失败'), { description: errorMessage(e) }))}
          >
            <FolderOpen />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('刷新项目文件')}
            title={t('刷新项目文件')}
            disabled={tree.directories.get('')?.loading}
            onClick={refresh}
          >
            <RotateCw />
          </Button>
        </div>
      </div>
      <div className="mb-3 shrink-0 px-2">
        <p className="truncate text-sm font-medium" title={root ?? undefined}>
          {root?.split(/[\\/]/).filter(Boolean).pop() ?? t('默认 Navo 工作区')}
        </p>
        <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground" title={root ?? undefined}>
          {root}
        </p>
        {!workingDirectory ? <p className="mt-1 text-xs text-muted-foreground">{t('当前使用默认共享工作区')}</p> : null}
        <Button variant="secondary" size="sm" className="mt-2" disabled={picking} loading={picking} onClick={() => void chooseDirectory()}>
          {workingDirectory ? t('更换文件夹') : t('选择文件夹')}
        </Button>
      </div>
      <label className="mb-2 flex items-center gap-2 px-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={tree.showHidden} onChange={toggleHidden} />
        {t('显示隐藏文件')}
      </label>
      <div
        ref={scroller}
        onScroll={(event) => {
          tree.scrollTop = event.currentTarget.scrollTop
        }}
        className="min-h-0 flex-1 overflow-auto"
        aria-busy={tree.directories.get('')?.loading}
      >
        {directory('')}
      </div>
    </section>
  )
}
