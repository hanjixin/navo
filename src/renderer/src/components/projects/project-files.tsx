import type { ProjectFileSearchResult } from '@shared/files-query'
import { Input } from '@/components/ui/input'
import { Check, Copy, ChevronDown, ChevronRight, File, Plus, Folder, FolderOpen, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { mainDraftScope, useDrafts } from '@/stores/drafts'
import { useParams, useSearchParams } from 'react-router'
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
const formatBytes = (size: number): string =>
  size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
const listDirectory = (projectId: string, path: string, showHidden: boolean, cursor?: string) =>
  call('projectFiles.listPage', projectId, path, showHidden, cursor)
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
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<ProjectFileSearchResult>()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<Map<string, ProjectFileSearchResult['entries'][number]>>(new Map())
  const pending = useRef(new Set<string>())
  const [params, setParams] = useSearchParams()
  const { threadId } = useParams()
  const addFile = async (path: string, name: string) => {
    if (!root) return
    try {
      await useDrafts.getState().addProjectFile(mainDraftScope(projectId, threadId), { projectId, root, path, name })
      toast.success(t('已添加到对话'))
    } catch (error) {
      toast.error(t('操作失败'), { description: errorMessage(error) })
    }
  }
  const selected = params.get('file')
  const folder = params.get('directory')
  const selectedSize = [...selectedFiles.values()].reduce((total, entry) => total + entry.size, 0)
  const toggleSelected = (entry: ProjectFileSearchResult['entries'][number]) => {
    setSelectedFiles((current) => {
      const next = new Map(current)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, entry)
      return next
    })
  }
  const addSelected = async () => {
    if (!root || !selectedFiles.size) return
    try {
      const scope = mainDraftScope(projectId, threadId)
      for (const entry of selectedFiles.values()) await useDrafts.getState().addProjectFile(scope, { projectId, root, path: entry.path, name: entry.name })
      toast.success(t('已添加 {{v0}} 个文件到对话', { v0: selectedFiles.size }))
      setSelectedFiles(new Map())
    } catch (error) {
      toast.error(t('操作失败'), { description: errorMessage(error) })
    }
  }
  const update = useCallback(() => {
    if (mounted.current) render((n) => n + 1)
  }, [])
  const load = useCallback(
    async (path: string, more = false) => {
      const previous = tree.directories.get(path)
      if (previous?.loading) {
        pending.current.add(path)
        return
      }
      const version = (previous?.version ?? 0) + 1
      tree.directories.set(path, { data: previous?.data, loading: true, error: null, version })
      update()
      try {
        const data = await listDirectory(projectId, path, tree.showHidden, more ? (previous?.data?.nextCursor ?? undefined) : undefined)
        if (more && previous?.data) data.entries = [...previous.data.entries, ...data.entries]
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
  useEffect(() => {
    if (!query.trim()) {
      setSearch(undefined)
      setSearchError(null)
      setSearching(false)
      return
    }
    const requestId = crypto.randomUUID()
    let live = true
    setSearching(true)
    setSearch(undefined)
    setSearchError(null)
    const timer = setTimeout(() => {
      void call('projectFiles.search', projectId, query, requestId, tree.showHidden)
        .then(
          (result) => {
            if (live) setSearch(result)
          },
          (error) => {
            if (live) setSearchError(errorMessage(error))
          },
        )
        .finally(() => {
          if (live) setSearching(false)
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
      void call('projectFiles.cancelSearch', requestId).catch(() => {})
    }
  }, [projectId, query, tree.showHidden])
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
            <div className="group flex items-center">
              {entry.kind === 'file' ? (
                <button
                  type="button"
                  className={cn(
                    'ml-1 flex size-5 shrink-0 items-center justify-center rounded border',
                    selectedFiles.has(entry.path) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                  aria-label={selectedFiles.has(entry.path) ? t('取消选择 {{name}}', { name: entry.name }) : t('选择文件 {{name}}', { name: entry.name })}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleSelected(entry)
                  }}
                >
                  {selectedFiles.has(entry.path) ? <Check className="size-3" /> : null}
                </button>
              ) : null}
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
              {entry.kind === 'file' ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0"
                  title={t('添加到对话')}
                  aria-label={t('添加到对话')}
                  onClick={() => void addFile(entry.path, entry.name)}
                >
                  <Plus />
                </Button>
              ) : null}
            </div>
            {entry.kind === 'directory' && tree.expanded.has(entry.path) ? directory(entry.path, depth + 1) : null}
          </div>
        ))}
        {!state.data.entries.length ? <p className="px-2 py-2 text-xs text-subtle-foreground">{t('此文件夹为空')}</p> : null}
        {state.data.nextCursor ? (
          <Button size="sm" loading={state.loading} onClick={() => void load(path, true)}>
            {t('加载更多')}
          </Button>
        ) : null}
      </>
    )
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col px-2 py-4" data-testid="project-files">
      <div className="mb-2 flex items-center justify-between gap-1 px-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{t('项目文件')}</h3>
          {selectedFiles.size ? (
            <span className="text-[11px] text-muted-foreground">
              {selectedFiles.size} · {formatBytes(selectedSize)}
            </span>
          ) : null}
        </div>
        <div className="flex gap-1">
          {selectedFiles.size ? (
            <Button size="sm" variant="secondary" onClick={() => void addSelected()}>
              {t('添加到对话')}
            </Button>
          ) : null}
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
      <div className="mb-2 px-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('搜索文件名或路径')} placeholder={t('搜索文件名或路径')} />
      </div>
      {query ? <p className="mb-2 px-2 text-xs text-muted-foreground">{t('搜索排除 .git 和 node_modules 文件夹')}</p> : null}
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
        {query.trim() ? (
          <>
            {searching ? <p className="p-2 text-xs">{t('加载中')}</p> : null}
            {searchError ? <ErrorState compact error={searchError} /> : null}
            {search?.entries.map((entry) => (
              <div key={entry.path} className="flex items-center gap-1">
                {entry.kind === 'file' ? (
                  <button
                    type="button"
                    className={cn(
                      'ml-1 flex size-5 shrink-0 items-center justify-center rounded border',
                      selectedFiles.has(entry.path) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )}
                    aria-label={selectedFiles.has(entry.path) ? t('取消选择 {{name}}', { name: entry.name }) : t('选择文件 {{name}}', { name: entry.name })}
                    onClick={() => toggleSelected(entry)}
                  >
                    {selectedFiles.has(entry.path) ? <Check className="size-3" /> : null}
                  </button>
                ) : null}
                <button
                  className="block min-w-0 flex-1 truncate rounded p-2 text-left text-xs hover:bg-accent"
                  onClick={() =>
                    setParams(() => {
                      const next = currentSearchParams()
                      next.delete('artifact')
                      if (entry.kind === 'file') {
                        next.set('file', entry.path)
                        next.delete('panel')
                      } else {
                        next.set('directory', entry.path)
                        next.set('panel', 'project')
                        next.delete('file')
                        setQuery('')
                      }
                      return next
                    })
                  }
                >
                  {entry.kind === 'directory' ? <Folder className="mr-1 inline size-3" /> : <File className="mr-1 inline size-3" />}
                  {entry.path}
                </button>
              </div>
            ))}
            {search?.truncated ? <p className="p-2 text-xs text-muted-foreground">{t('搜索结果已截断，请缩小搜索范围')}</p> : null}
            {search && !search.entries.length ? <p className="p-2 text-xs text-muted-foreground">{t('没有匹配文件')}</p> : null}
          </>
        ) : (
          directory('')
        )}
      </div>
    </section>
  )
}
