import {
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  Globe,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { DayEntry, Memory, MemoryKind } from '@shared/types'
import { PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { KIND_HINT, KIND_LABEL, useMemories } from '@/stores/memory'
import { useSettings } from '@/stores/settings'

const KINDS: MemoryKind[] = ['profile', 'preference', 'knowledge', 'site']
const KIND_ICON = { profile: User, preference: Sparkles, knowledge: BookOpen, site: Globe } as const
type Filter = 'all' | MemoryKind | 'pending' | 'daily'

// ---------- editor

function MemoryEditor({ initial, onClose }: { initial: Partial<Memory> | null; onClose: () => void }) {
  const [kind, setKind] = useState<MemoryKind>(initial?.kind ?? 'preference')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [site, setSite] = useState(initial?.scope ?? '')
  const [pinned, setPinned] = useState(initial?.pinned ?? false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const editing = !!initial?.id
  const canSave = title.trim() && content.trim() && (kind !== 'site' || site.trim())

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await call('memory.save', { id: initial?.id, kind, title, content, scope: kind === 'site' ? site : null, pinned })
      toast.success(editing ? '已保存' : '已添加记忆')
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={editing ? '编辑记忆' : '新建记忆'}
        description="写成一两句话，Navo 会在相关的对话里自然地用上。"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={!canSave || saving} onClick={() => void save()}>
              {editing ? '保存' : '添加'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="类型" hint={KIND_HINT[kind]}>
            <Select value={kind} onChange={(v) => setKind(v as MemoryKind)} options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          </Field>
          {kind === 'site' ? (
            <Field label="网站" hint="填域名即可，子域名也会生效">
              <Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="taobao.com" className="font-mono text-xs" />
            </Field>
          ) : null}
          <Field label="标题">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              placeholder={kind === 'site' ? '如：搜索前先关弹窗' : '如：回答风格'}
              autoFocus
            />
          </Field>
          <Field label="内容" hint={`${content.length} / 1000`}>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={1000}
              rows={4}
              placeholder={kind === 'preference' ? '如：用户希望回答先给结论，再用要点展开。' : '一两句话，以「用户」为主语'}
            />
          </Field>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              置顶
              <span className="block text-xs text-muted-foreground">每次对话都会带上，不依赖相关性</span>
            </span>
            <Switch checked={pinned} onCheckedChange={setPinned} />
          </label>
          {error ? <ErrorState error={error} compact /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- settings

function MemorySettingsDialog({ count, onClose }: { count: number; onClose: () => void }) {
  const { settings, update } = useSettings()
  const cfg = settings!.memory
  const [confirmClear, setConfirmClear] = useState(false)
  const row = (label: string, hint: string, value: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label className={cn('flex items-center justify-between gap-4 text-sm', disabled && 'opacity-60')}>
      <span>
        {label}
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </label>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="记忆设置"
        footer={
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        }
      >
        <div className="grid gap-5">
          {row('使用记忆', '对话时带上与你有关的记忆。关闭后既不读取也不学习。', cfg.enabled, (v) => void update({ memory: { ...cfg, enabled: v } }))}
          {row(
            '自动学习',
            '每次回复后，从对话中挑出值得长期记住的内容（会额外调用一次模型）。',
            cfg.autoLearn,
            (v) => void update({ memory: { ...cfg, autoLearn: v } }),
            !cfg.enabled,
          )}
          {row(
            '每日记录',
            '每天为每个对话记一句话日记，方便之后回顾或接着做（与自动学习共用一次模型调用）。',
            cfg.daily,
            (v) => void update({ memory: { ...cfg, daily: v } }),
            !cfg.enabled,
          )}
          {row(
            '新记忆需要我确认',
            '自动学到的内容先放进「待确认」，确认后才会使用。',
            cfg.review,
            (v) => void update({ memory: { ...cfg, review: v } }),
            !cfg.enabled || !cfg.autoLearn,
          )}
          <div className="flex items-center justify-between gap-4 border-t border-border pt-4 text-sm">
            <span>
              清空全部记忆
              <span className="block text-xs text-muted-foreground">删除 {count} 条记忆，无法恢复</span>
            </span>
            {confirmClear ? (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                  取消
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    await call('memory.clear')
                    setConfirmClear(false)
                    toast.success('已清空全部记忆')
                  }}
                >
                  确认清空
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" disabled={!count} onClick={() => setConfirmClear(true)}>
                清空
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- list

function MemoryRow({ m, focused, onEdit }: { m: Memory; focused: boolean; onEdit: () => void }) {
  const Icon = KIND_ICON[m.kind]
  // short memories (e.g. imported bullets) whose title is the content: show the text once
  const titleOnly = m.content.replace(/[。.！!]$/, '').trim() === m.title.trim()
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focused])

  const remove = async () => {
    await call('memory.delete', m.id)
    toast('已删除记忆', { description: m.title, action: { label: '撤销', onClick: () => void call('memory.restore', m) } })
  }

  return (
    <div
      ref={ref}
      data-testid="memory-row"
      className={cn(
        'group flex items-start gap-3 rounded-lg border bg-card px-4 py-3 transition-[border-color,box-shadow] duration-150 hover:border-input',
        focused ? 'border-primary/50 ring-2 ring-primary/15' : 'border-border',
      )}
    >
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-3.5 stroke-[1.75]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{m.title}</span>
          {m.pinned ? <Pin className="size-3 shrink-0 text-brand" aria-label="已置顶" /> : null}
          {m.status === 'pending' ? <Badge variant="warning">待确认</Badge> : null}
        </div>
        {titleOnly ? null : <p className="selectable mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">{m.content}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
          <span>{KIND_LABEL[m.kind]}</span>
          {m.scope ? <span className="font-mono">{m.scope}</span> : null}
          {m.source ? (
            <button
              className="interactive flex max-w-60 items-center gap-1 truncate hover:text-foreground"
              onClick={() => {
                useChat.getState().select(m.source!.threadId)
                navigate('/chat')
              }}
              title="打开来源对话"
            >
              <MessageSquare className="size-3 shrink-0" />
              <span className="truncate">{m.source.title || '来源对话'}</span>
            </button>
          ) : null}
          <span>更新于 {timeAgo(m.updatedAt)}</span>
          {m.useCount ? <span>用过 {m.useCount} 次</span> : null}
        </div>
      </div>
      {m.status === 'pending' ? (
        <div className="flex shrink-0 gap-1">
          <Button variant="secondary" size="sm" onClick={() => void call('memory.confirm', [m.id])}>
            <Check />
            确认
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="忽略" onClick={() => void call('memory.delete', m.id)}>
            <X />
          </Button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label="更多操作"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              编辑
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void call('memory.pin', m.id, !m.pinned)}>
              {m.pinned ? <PinOff /> : <Pin />}
              {m.pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={() => void remove()}>
              <Trash2 />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

// ---------- daily journal

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  const today = new Date()
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - d.getTime()) / 86_400_000)
  const date = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`
  return diff === 0 ? `今天 · ${date}` : diff === 1 ? `昨天 · ${date}` : d.getFullYear() === today.getFullYear() ? date : `${d.getFullYear()}年${date}`
}

function DayRow({ e }: { e: DayEntry }) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(e.text)
  const save = async () => {
    try {
      await call('memory.editDay', e.day, e.threadId, text)
      setEditing(false)
    } catch (err) {
      toast.error('保存失败', { description: errorMessage(err) })
    }
  }
  const cancel = () => {
    setEditing(false)
    setText(e.text)
  }
  return (
    <li data-testid="day-entry" className="group relative flex gap-3 py-2 pl-4">
      <span className="absolute top-[15px] left-0 size-1.5 rounded-full bg-border" aria-hidden />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="grid gap-2">
            <Textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={2} maxLength={200} autoFocus />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => void save()}>
                保存
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <p className="selectable text-sm">{e.text}</p>
        )}
        <button
          className="interactive mt-0.5 flex max-w-full items-center gap-1 truncate text-xs text-subtle-foreground hover:text-foreground"
          onClick={() => {
            useChat.getState().select(e.threadId)
            navigate('/chat')
          }}
          title="打开这个对话"
        >
          <MessageSquare className="size-3 shrink-0" />
          <span className="truncate">{e.threadTitle}</span>
          <span className="shrink-0">· {new Date(e.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        </button>
      </div>
      {!editing ? (
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="icon-sm" aria-label="编辑日记" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:text-danger"
            aria-label="删除日记"
            onClick={() => void call('memory.deleteDay', e.day, e.threadId)}
          >
            <Trash2 />
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function DaysView({ q }: { q: string }) {
  const [days, setDays] = useState<DayEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const load = () =>
      call('memory.days', 500).then(
        (d) => {
          setDays(d)
          setError(null)
        },
        (e) => setError(errorMessage(e)),
      )
    void load()
    return on('memory.changed', () => void load())
  }, [])
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const map = new Map<string, DayEntry[]>()
    for (const e of days ?? []) {
      if (needle && !`${e.text} ${e.threadTitle}`.toLowerCase().includes(needle)) continue
      map.set(e.day, [...(map.get(e.day) ?? []), e])
    }
    return [...map]
  }, [days, q])

  if (error && !days) return <ErrorState error={error} />
  if (!days) return <ListSkeleton rows={4} />
  if (!days.length)
    return (
      <EmptyState
        icon={CalendarDays}
        title="还没有日记"
        description="Navo 会在每次回复后，用一句话记下你今天在这个对话里做了什么。之后可以直接问它「昨天我们做了什么」。"
      />
    )
  if (!groups.length) return <p className="py-12 text-center text-sm text-muted-foreground">没有匹配的日记</p>
  return (
    <div className="grid gap-5">
      {groups.map(([day, entries]) => (
        <section key={day}>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{dayLabel(day)}</h3>
          <ul className="rounded-lg border border-border bg-card px-4 py-1">
            {entries.map((e) => (
              <DayRow key={e.threadId} e={e} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function MemoryPage() {
  const { items, error, load } = useMemories()
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Partial<Memory> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const filter = (params.get('filter') as Filter | null) ?? 'all'
  const focus = params.get('focus')

  useEffect(() => {
    void load()
  }, [load])

  const pending = useMemo(() => (items ?? []).filter((m) => m.status === 'pending'), [items])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 }
    for (const m of items ?? []) {
      if (m.status !== 'active') continue
      c[m.kind] = (c[m.kind] ?? 0) + 1
      c.all++
    }
    return c
  }, [items])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (items ?? []).filter(
      (m) =>
        (filter === 'pending' ? m.status === 'pending' : m.status === 'active' && (filter === 'all' || m.kind === filter)) &&
        (!needle || `${m.title}\n${m.content}\n${m.scope ?? ''}`.toLowerCase().includes(needle)),
    )
  }, [items, filter, q])

  const setFilter = (f: string) => setParams(f === 'all' ? {} : { filter: f }, { replace: true })
  const enabled = settings?.memory.enabled ?? true

  return (
    <div className="@container flex h-full flex-col overflow-y-auto px-6 pt-6 pb-10 @4xl:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader
          title="记忆"
          description="Navo 记住的关于你的信息，会在相关对话中自动使用，可随时修改或删除。"
          actions={
            <>
              <Button variant="secondary" onClick={() => setSettingsOpen(true)} disabled={!settings}>
                <Settings2 />
                设置
              </Button>
              <Button variant="primary" onClick={() => setEditing({})}>
                <Plus />
                新建记忆
              </Button>
            </>
          }
        />

        {!enabled ? (
          <div className="mb-4 flex items-center justify-between gap-4 rounded-md border-l-2 border-l-warning bg-warning-soft px-4 py-2.5 text-sm">
            <span className="text-muted-foreground">记忆已关闭：对话不会读取，也不会学习新的记忆。</span>
            <Button variant="secondary" size="sm" onClick={() => void update({ memory: { ...settings!.memory, enabled: true } })}>
              开启
            </Button>
          </div>
        ) : null}
        {pending.length && filter !== 'pending' ? (
          <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-2.5 text-sm">
            <span>
              有 <span className="font-medium">{pending.length}</span> 条自动学到的记忆等你确认
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setFilter('pending')}>
                查看
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void call(
                    'memory.confirm',
                    pending.map((m) => m.id),
                  )
                }
              >
                全部确认
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="all">全部 {counts.all ? <span className="ml-1 text-subtle-foreground">{counts.all}</span> : null}</TabsTrigger>
              {KINDS.map((k) => (
                <TabsTrigger key={k} value={k}>
                  {KIND_LABEL[k]}
                  {counts[k] ? <span className="ml-1 text-subtle-foreground">{counts[k]}</span> : null}
                </TabsTrigger>
              ))}
              <TabsTrigger value="daily">每日</TabsTrigger>
              {pending.length ? (
                <TabsTrigger value="pending">
                  待确认 <span className="ml-1 text-warning">{pending.length}</span>
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
          <div className="relative w-full @2xl:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索记忆" className="h-8 pl-8 text-sm" />
          </div>
        </div>

        {filter === 'daily' ? (
          <DaysView q={q} />
        ) : error && !items ? (
          <ErrorState error={error} onRetry={() => void load()} />
        ) : !items ? (
          <ListSkeleton rows={5} />
        ) : !items.length ? (
          <EmptyState
            icon={Brain}
            title="还没有记忆"
            description="和 Navo 聊天时，它会记住你的偏好、常用信息和网站操作经验。你也可以直接告诉它「记住……」，或在这里手动添加。"
            action={
              <Button variant="primary" onClick={() => setEditing({})}>
                <Plus />
                新建记忆
              </Button>
            }
          />
        ) : !shown.length ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {q ? '没有匹配的记忆' : filter === 'pending' ? '没有待确认的记忆' : '这一类还没有记忆'}
          </p>
        ) : (
          <div className="grid gap-2">
            {filter !== 'all' && filter !== 'pending' ? <p className="mb-1 text-xs text-muted-foreground">{KIND_HINT[filter]}</p> : null}
            {shown.map((m) => (
              <MemoryRow key={m.id} m={m} focused={focus === m.id} onEdit={() => setEditing(m)} />
            ))}
          </div>
        )}
      </div>

      {editing ? <MemoryEditor initial={editing} onClose={() => setEditing(null)} /> : null}
      {settingsOpen && settings ? <MemorySettingsDialog count={items?.length ?? 0} onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}
