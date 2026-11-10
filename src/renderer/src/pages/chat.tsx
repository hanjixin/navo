import {
  Brain,
  Clock3,
  Workflow,
  Activity,
  Cpu,
  Globe,
  MessageSquare,
  Newspaper,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sparkles,
  Square,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { Decision } from '@shared/types'
import { Composer } from '@/components/chat/composer'
import { runtimeConversationDescription } from '@/components/chat/runtime-description'
import { useRuntimes } from '@/stores/runtimes'
import { InterruptCard } from '@/components/chat/interrupt-card'
import { MessageList } from '@/components/chat/message-list'
import { TodoPanel } from '@/components/chat/todo-panel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useDraft } from '@/hooks/use-draft'
import { DesktopConsentInline } from '@/components/chat/desktop-consent'
import { mainDraftScope, submitDraft } from '@/stores/drafts'
import { useModels } from '@/stores/models'
import { threadsOpen, useLayout } from '@/stores/layout'
import { Tooltip } from '@/components/ui/tooltip'
import { useAsync } from '@/hooks/use-async'
import { useSettings } from '@/stores/settings'
import { useProjects } from '@/stores/projects'
import { useFlowDialog } from '@/stores/flows'
import { ThreadList } from '@/components/chat/thread-list'
import { currentSearchParams, projectPath, threadPath } from '@/lib/routes'
import { t } from '@shared/i18n'

const SUGGESTIONS = [
  { icon: Newspaper, text: t('打开 Hacker News，总结今天排名前 5 的文章') },
  { icon: Search, text: t('在必应搜索 “LangGraph deepagents”，整理 3 个最有用的链接') },
  { icon: Globe, text: t('读取当前浏览器页面，提炼要点并保存到 /workspace/notes.md') },
  { icon: Sparkles, text: t('记住：我偏好简洁的中文回答，并写入长期记忆') },
]

/** Shown when the conversation's last run did something in the browser that could be replayed. */
function SaveFlowButton({ threadId, messages }: { threadId: string; messages: number }) {
  const info = useAsync(() => call('flows.traceInfo', threadId), [threadId, messages])
  if (!info.data) return null
  return (
    <Tooltip content={t('把刚才的 {{v0}} 步浏览器操作保存成固定流程，下次直接回放、不调用模型', { v0: info.data.actions })}>
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => useFlowDialog.getState().open(threadId)}>
        <Workflow />
        {t('固化流程')}
      </Button>
    </Tooltip>
  )
}

/** The files this conversation produced (written by the agent, or downloaded): preview and export. */
function OutputsButton({ threadId, messages }: { threadId: string; messages: number }) {
  const list = useAsync(() => call('outputs.list', threadId), [threadId, messages])
  const [, setSearchParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  useEffect(
    () =>
      on('outputs.changed', (e) => {
        if (e.threadId === threadId) list.reload()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId],
  )
  const n = list.data?.length ?? 0
  if (!n) return null
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button data-testid="outputs-button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
          <PackageOpen />
          {t('产出 {{v0}}', { v0: n })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="output-list">
        {list.data?.map((file) => (
          <DropdownMenuItem
            key={file.id}
            onSelect={() => {
              setOpen(false)
              setSearchParams(() => {
                const next = currentSearchParams()
                next.set('artifact', file.id)
                next.delete('file')
                next.delete('panel')
                return next
              })
            }}
          >
            {file.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Per-conversation memory switch: off = this conversation neither reads nor learns memories. */
function ThreadMemoryToggle({ threadId }: { threadId: string }) {
  const globalOn = useSettings((s) => s.settings?.memory.enabled ?? true)
  const state = useAsync(() => call('memory.threadEnabled', threadId), [threadId, globalOn])
  if (!globalOn || state.data == null) return null
  const on = state.data
  return (
    <Tooltip content={on ? t('本对话会使用并学习记忆，点击关闭') : t('本对话不读取、也不学习记忆，点击开启')}>
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-7 gap-1 px-2 text-xs', on ? 'text-muted-foreground' : 'text-warning')}
        aria-pressed={on}
        aria-label={on ? t('关闭本对话的记忆') : t('开启本对话的记忆')}
        onClick={async () => {
          await call('memory.setThreadEnabled', threadId, !on)
          state.reload()
        }}
      >
        <Brain className={cn(!on && 'opacity-60')} />
        {on ? t('记忆') : t('记忆已关闭')}
      </Button>
    </Tooltip>
  )
}

export function ChatPage() {
  const { views, threads, threadsError, select, sendTo, newThread, regenerate, loadThreads, loadThread } = useChat()
  const { threadId, projectId } = useParams<{ threadId: string; projectId: string }>()
  const activeId = threadId ?? null
  const location = useLocation()
  const { projects, load: loadProjects } = useProjects()
  const showThreads = useLayout(threadsOpen)
  const toggleThreads = useLayout((s) => s.toggleThreads)
  const { activeModels: models, load: loadModels } = useModels()
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const view = activeId ? views[activeId] : undefined
  const thread = threads?.find((item) => item.id === activeId)
  const draft = useDraft(mainDraftScope(projectId, activeId ?? undefined))
  const draftModelId = draft.data?.modelId ?? null
  const runtimeId = thread?.runtimeId ?? (activeId ? 'builtin' : (draft.data?.runtimeId ?? 'builtin'))
  const external = runtimeId !== 'builtin' && runtimeId !== 'pi'
  const runtime = useRuntimes((state) => state.runtimes?.find((item) => item.profile.id === runtimeId))
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void loadThreads()
    void loadModels()
    void loadProjects()
  }, [loadThreads, loadModels, loadProjects, activeId])

  useEffect(() => {
    select(activeId)
  }, [activeId, select])

  // Ownership changes (including deletion of a project) keep the URL canonical.
  useEffect(() => {
    if (!thread || window.location.hash.slice(1).split('?')[0] !== location.pathname) return
    const canonical = threadPath(thread)
    const query = currentSearchParams().toString()
    if (location.pathname !== canonical) navigate(canonical + (query ? `?${query}` : ''), { replace: true })
  }, [thread, location.pathname, location.search, navigate])

  useEffect(() => {
    stick.current = true
  }, [activeId])

  useEffect(() => {
    if (!view?.running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [view?.running])

  // auto-scroll while the user is at the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [view?.messages, view?.todos, view?.interrupt])

  const noModels = !external && models !== undefined && models.length === 0
  const elapsed = view?.runStartedAt ? Math.max(0, now - view.runStartedAt) : 0
  const elapsedLabel = `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}`

  const onModelChange = async (modelId: string) => {
    draft.patch({ modelId })
  }

  const decide = async (decisions: Decision[], alwaysAllow?: string[]) => {
    if (!activeId) return
    useChat.setState((s) => ({
      views: {
        ...s.views,
        [activeId]: { ...s.views[activeId], interrupt: null, running: true, runStartedAt: Date.now(), lastActivityAt: Date.now() },
      },
    }))
    try {
      await call('chat.resume', activeId, decisions, alwaysAllow, view?.interrupt?.id)
    } catch (e) {
      useChat.setState((s) => ({
        views: { ...s.views, [activeId]: { ...s.views[activeId], running: false, runStartedAt: null, error: errorMessage(e) } },
      }))
      toast.error(t('提交失败'), { description: errorMessage(e) })
    }
  }

  const send = async (text: string, images?: string[], fileIds?: string[]) => {
    try {
      const target = thread ?? (await newThread(draftModelId, projectId ?? null, runtimeId))
      if (!thread) navigate(threadPath(target))
      await sendTo(target.id, text, images, fileIds)
    } catch (e) {
      toast.error(t('提交失败'), { description: errorMessage(e) })
    }
  }
  const createThread = () => {
    select(null)
    const project = thread?.projectId ?? projectId
    navigate(project ? projectPath(project) : '/chat')
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
  }
  const missingThread = !!activeId && threads !== undefined && !thread
  const missingProject = !!projectId && projects !== undefined && !projects.some((project) => project.id === projectId)
  // A found thread can legitimately have moved away from this project; canonicalization handles it.
  const routeError = missingThread ? t('会话不存在') : missingProject && !thread ? t('项目不存在') : threadsError
  const empty = !view || (view.loaded && view.messages.length === 0)

  return (
    <div className="flex h-full">
      {showThreads ? <ThreadList projectId={thread?.projectId ?? projectId} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <Tooltip content={showThreads ? t('收起对话列表') : t('展开对话列表')}>
            <Button variant="ghost" size="icon-sm" onClick={toggleThreads} aria-label={t('切换对话列表')} aria-expanded={showThreads}>
              {showThreads ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </Tooltip>
          {thread?.projectId ? (
            <Link className="truncate px-1 text-xs text-muted-foreground hover:text-foreground" to={projectPath(thread.projectId)}>
              {projects?.find((project) => project.id === thread.projectId)?.name ?? t('项目')}
            </Link>
          ) : null}
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{thread?.title ?? t('新对话')}</span>
          {view?.running ? (
            <span
              className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground"
              title={view.lastActivityAt ? t('最近活动：{{v0}}', { v0: timeAgo(view.lastActivityAt) }) : undefined}
            >
              <span className="size-1.5 animate-pulse rounded-full bg-brand" />
              {view.interrupt ? t('等待确认') : t('运行中')}
              <Clock3 className="size-3" />
              <span className="font-mono tabular-nums">{elapsedLabel}</span>
              <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => activeId && void call('chat.stop', activeId)} aria-label={t('停止')}>
                <Square className="size-3 fill-current" />
              </Button>
            </span>
          ) : null}
          {thread ? <OutputsButton key={`outputs-${thread.id}`} threadId={thread.id} messages={view?.messages.length ?? 0} /> : null}
          {thread && !external && !view?.running ? (
            <SaveFlowButton key={`flow-${thread.id}`} threadId={thread.id} messages={view?.messages.length ?? 0} />
          ) : null}
          {thread && !external ? <ThreadMemoryToggle key={`memory-${thread.id}`} threadId={thread.id} /> : null}
          {view?.traceUrl && !view.running ? (
            <Tooltip content={t('在 Langfuse 中查看本次运行')}>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void call('app.openExternal', view.traceUrl!)}>
                <Activity />
                Trace
              </Button>
            </Tooltip>
          ) : null}
          {!showThreads ? (
            <Tooltip content={t('新建对话')}>
              <Button variant="ghost" size="icon-sm" onClick={() => void createThread()} aria-label={t('新建对话')}>
                <Plus />
              </Button>
            </Tooltip>
          ) : null}
        </div>
        <div
          ref={scrollRef}
          className="@container min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div className="mx-auto w-full max-w-3xl min-w-0 px-6 pt-6 pb-6">
            {routeError ? (
              <ErrorState error={routeError} onRetry={loadThreads} />
            ) : activeId && threads === undefined ? (
              <Skeleton className="h-20 w-full" />
            ) : noModels && empty ? (
              <EmptyState
                icon={Cpu}
                title={t('还没有可用的模型')}
                description={t('没有已启用的模型，请前往模型页面启用')}
                action={
                  <Button variant="primary" onClick={() => navigate('/models')}>
                    {t('管理模型')}
                  </Button>
                }
                className="pt-24"
              />
            ) : view?.loadError ? (
              <ErrorState error={view.loadError} onRetry={() => activeId && loadThread(activeId)} />
            ) : activeId && view && !view.loaded ? (
              <div className="grid gap-6">
                <Skeleton className="ml-auto h-9 w-1/2 rounded-lg" />
                <div className="grid gap-2">
                  <Skeleton className="h-3.5 w-11/12" />
                  <Skeleton className="h-3.5 w-4/5" />
                  <Skeleton className="h-3.5 w-2/3" />
                </div>
              </div>
            ) : empty ? (
              <div className="animate-fade-in pt-16">
                <div className="mb-1 flex size-9 items-center justify-center rounded-lg border border-border bg-card">
                  <MessageSquare className="size-4 stroke-[1.75] text-muted-foreground" />
                </div>
                <h2 className="mt-4 text-xl font-semibold tracking-[-0.01em]">{t('今天想让我完成什么？')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {external ? runtimeConversationDescription(runtime?.capabilities) : t('我可以操作右侧的浏览器、调用连接器与 MCP 工具，并记住你的偏好。')}
                </p>
                <div className="mt-6 grid grid-cols-1 gap-2 @xl:grid-cols-2">
                  {(external && !runtime?.capabilities.navoTools ? [] : SUGGESTIONS).map((s) => (
                    <button
                      key={s.text}
                      onClick={() => void send(s.text)}
                      className="card-hover flex items-start gap-2.5 rounded-lg border border-border bg-card px-3.5 py-3 text-left text-sm text-muted-foreground hover:text-foreground"
                    >
                      <s.icon className="mt-0.5 size-4 shrink-0 stroke-[1.75]" />
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : view ? (
              <MessageList
                messages={view.messages}
                running={view.running}
                actions={
                  runtimeId !== 'builtin'
                    ? undefined
                    : { onRegenerate: (id) => void regenerate(id, undefined, activeId!), onEdit: (id, text) => void regenerate(id, text, activeId!) }
                }
              />
            ) : null}
            {view?.error ? <ErrorState error={view.error} compact className="mt-4" /> : null}
          </div>
        </div>

        <div className="mx-auto grid w-full max-w-3xl gap-2 px-6 pb-5">
          <DesktopConsentInline />
          {!view?.running && view?.recoverableMessageIds?.length ? (
            <div role="status" className="rounded-lg border border-border p-3 text-sm">
              <p>{t('上次消息已保存，但执行中断。确认后可继续。')}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void call('chat.retrySubmission', activeId!, view.recoverableMessageIds![0]).catch((e) =>
                    toast.error(t('提交失败'), { description: errorMessage(e) }),
                  )
                }
              >
                {t('继续已保存的消息')}
              </Button>
            </div>
          ) : null}
          {view?.interrupt ? <InterruptCard interrupt={view.interrupt} onDecide={decide} /> : null}
          {view?.todos.length ? <TodoPanel todos={view.todos} /> : null}
          <Composer
            draftScope={draft.scope}
            runtimeId={runtimeId}
            value={draft.data?.text ?? ''}
            onValueChange={(text) => draft.patch({ text })}
            onSend={async () => {
              const receipt = await submitDraft(draft.scope, {
                threadId: activeId ?? undefined,
                projectId,
                modelId: draftModelId ?? thread?.modelId,
                runtimeId,
              })
              await loadThreads()
              select(receipt.threadId)
              if (!activeId) navigate(threadPath({ id: receipt.threadId, projectId: projectId ?? null }))
            }}
            onStop={() => activeId && void call('chat.stop', activeId)}
            running={!!view?.running}
            modelId={draftModelId ?? thread?.modelId ?? null}
            onModelChange={onModelChange}
            disabled={draft.loading || !!view?.interrupt || !!routeError || (!!activeId && !thread)}
            disabledReason={routeError ?? (noModels ? t('没有已启用的模型，请前往模型页面启用') : t('请先处理上方的确认'))}
          />
        </div>
      </div>
    </div>
  )
}
