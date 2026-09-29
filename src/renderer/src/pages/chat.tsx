import {
  Brain,
  Activity,
  Cpu,
  Globe,
  MessageSquare,
  MoreHorizontal,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { Decision, Thread } from '@shared/types'
import { Composer } from '@/components/chat/composer'
import { InterruptCard } from '@/components/chat/interrupt-card'
import { MessageList } from '@/components/chat/message-list'
import { TodoPanel } from '@/components/chat/todo-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states'
import { call } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useModels } from '@/stores/models'
import { threadsOpen, useLayout } from '@/stores/layout'
import { Tooltip } from '@/components/ui/tooltip'
import { useAsync } from '@/hooks/use-async'
import { useSettings } from '@/stores/settings'

const SUGGESTIONS = [
  { icon: Newspaper, text: '打开 Hacker News，总结今天排名前 5 的文章' },
  { icon: Search, text: '在必应搜索 “LangGraph deepagents”，整理 3 个最有用的链接' },
  { icon: Globe, text: '读取当前浏览器页面，提炼要点并保存到 /workspace/notes.md' },
  { icon: Sparkles, text: '记住：我偏好简洁的中文回答，并写入长期记忆' },
]

function ThreadList() {
  const { threads, threadsError, activeId, select, newThread, loadThreads, views } = useChat()
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<Thread | null>(null)
  const [title, setTitle] = useState('')
  const filtered = useMemo(() => (threads ?? []).filter((t) => t.title.toLowerCase().includes(q.toLowerCase())), [threads, q])

  const remove = async (t: Thread) => {
    try {
      await call('threads.delete', t.id)
      if (activeId === t.id) select(null)
      await loadThreads()
    } catch (e) {
      toast.error('删除失败', { description: errorMessage(e) })
    }
  }

  return (
    <div className="flex w-60 shrink-0 animate-fade-in flex-col border-r border-border">
      <div className="flex items-center gap-1.5 p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索对话" className="h-7 pl-7 text-xs" />
        </div>
        <Button variant="secondary" size="icon-sm" onClick={() => void newThread()} aria-label="新建对话">
          <Plus />
        </Button>
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
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">{q ? '没有匹配的对话' : '还没有对话'}</p>
        ) : (
          <div className="grid gap-px">
            {filtered.map((t) => {
              const running = views[t.id]?.running
              return (
                <div
                  key={t.id}
                  onClick={() => select(t.id)}
                  className={cn(
                    'interactive group flex h-9 cursor-default items-center gap-2 rounded-md pr-1 pl-2.5 text-sm',
                    activeId === t.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" /> : null}
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 text-[11px] text-subtle-foreground group-hover:hidden">{timeAgo(t.updatedAt)}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <button
                        className="interactive hidden rounded-sm p-1 text-muted-foreground group-hover:block hover:bg-card data-[state=open]:block"
                        aria-label="更多"
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        onSelect={() => {
                          setTitle(t.title)
                          setRenaming(t)
                        }}
                      >
                        <Pencil />
                        重命名
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger onSelect={() => void remove(t)}>
                        <Trash2 />
                        删除
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
            title="重命名对话"
            className="w-[400px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setRenaming(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    await call('threads.rename', renaming.id, title)
                    setRenaming(null)
                    void loadThreads()
                  }}
                >
                  保存
                </Button>
              </>
            }
          >
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}

/** Per-conversation memory switch: off = this conversation neither reads nor learns memories. */
function ThreadMemoryToggle({ threadId }: { threadId: string }) {
  const globalOn = useSettings((s) => s.settings?.memory.enabled ?? true)
  const state = useAsync(() => call('memory.threadEnabled', threadId), [threadId, globalOn])
  if (!globalOn || state.data == null) return null
  const on = state.data
  return (
    <Tooltip content={on ? '本对话会使用并学习记忆，点击关闭' : '本对话不读取、也不学习记忆，点击开启'}>
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-7 gap-1 px-2 text-xs', on ? 'text-muted-foreground' : 'text-warning')}
        aria-pressed={on}
        aria-label={on ? '关闭本对话的记忆' : '开启本对话的记忆'}
        onClick={async () => {
          await call('memory.setThreadEnabled', threadId, !on)
          state.reload()
        }}
      >
        <Brain className={cn(!on && 'opacity-60')} />
        {on ? '记忆' : '记忆已关闭'}
      </Button>
    </Tooltip>
  )
}

export function ChatPage() {
  const { activeId, views, threads, send, regenerate, loadThreads, loadThread } = useChat()
  const showThreads = useLayout(threadsOpen)
  const toggleThreads = useLayout((s) => s.toggleThreads)
  const { models, load: loadModels } = useModels()
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const view = activeId ? views[activeId] : undefined
  const thread = threads?.find((t) => t.id === activeId)

  useEffect(() => {
    void loadThreads()
    void loadModels()
  }, [loadThreads, loadModels])

  // auto-scroll while the user is at the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [view?.messages, view?.todos, view?.interrupt])

  const noModels = models !== undefined && models.length === 0

  const onModelChange = async (modelId: string) => {
    if (!activeId) return
    await call('threads.setModel', activeId, modelId)
    void loadThreads()
  }

  const decide = async (decisions: Decision[], alwaysAllow?: string[]) => {
    if (!activeId) return
    useChat.setState((s) => ({ views: { ...s.views, [activeId]: { ...s.views[activeId], interrupt: null, running: true } } }))
    try {
      await call('chat.resume', activeId, decisions, alwaysAllow)
    } catch (e) {
      toast.error('提交失败', { description: errorMessage(e) })
    }
  }

  const empty = !view || (view.loaded && view.messages.length === 0)

  return (
    <div className="flex h-full">
      {showThreads ? <ThreadList /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <Tooltip content={showThreads ? '收起对话列表' : '展开对话列表'}>
            <Button variant="ghost" size="icon-sm" onClick={toggleThreads} aria-label="切换对话列表" aria-expanded={showThreads}>
              {showThreads ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{thread?.title ?? '新对话'}</span>
          {view?.running ? (
            <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-brand" />
              运行中
            </span>
          ) : null}
          {thread ? <ThreadMemoryToggle threadId={thread.id} /> : null}
          {view?.traceUrl && !view.running ? (
            <Tooltip content="在 Langfuse 中查看本次运行">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void call('app.openExternal', view.traceUrl!)}>
                <Activity />
                Trace
              </Button>
            </Tooltip>
          ) : null}
          {!showThreads ? (
            <Tooltip content="新建对话">
              <Button variant="ghost" size="icon-sm" onClick={() => void useChat.getState().newThread()} aria-label="新建对话">
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
            {noModels ? (
              <EmptyState
                icon={Cpu}
                title="还没有可用的模型"
                description="添加 Anthropic、OpenAI（Chat / Responses）或兼容 OpenAI 接口的提供方后即可开始对话。"
                action={
                  <Button variant="primary" onClick={() => navigate('/models')}>
                    添加模型
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
                <h2 className="mt-4 text-xl font-semibold tracking-[-0.01em]">今天想让我完成什么？</h2>
                <p className="mt-1 text-sm text-muted-foreground">我可以操作右侧的浏览器、调用连接器与 MCP 工具，并记住你的偏好。</p>
                <div className="mt-6 grid grid-cols-1 gap-2 @xl:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
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
                actions={{ onRegenerate: (id) => void regenerate(id), onEdit: (id, text) => void regenerate(id, text) }}
              />
            ) : null}
            {view?.error ? <ErrorState error={view.error} compact className="mt-4" /> : null}
          </div>
        </div>

        <div className="mx-auto grid w-full max-w-3xl gap-2 px-6 pb-5">
          {view?.interrupt ? <InterruptCard interrupt={view.interrupt} onDecide={decide} /> : null}
          {view?.todos.length ? <TodoPanel todos={view.todos} /> : null}
          <Composer
            onSend={(t, fileIds) => void send(t, [], fileIds)}
            onStop={() => activeId && void call('chat.stop', activeId)}
            running={!!view?.running}
            modelId={thread?.modelId ?? null}
            onModelChange={onModelChange}
            disabled={noModels || !!view?.interrupt}
            disabledReason={noModels ? '请先在「模型」页面配置模型' : '请先处理上方的确认'}
          />
        </div>
      </div>
    </div>
  )
}
