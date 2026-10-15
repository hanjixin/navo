import { CalendarClock, History, ListChecks, MessageSquare, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { MonitorConfig, Task, TaskRunStatus } from '@shared/types'
import { MonitorFields } from '@/components/tasks/monitor-fields'
import { MonitorHistory } from '@/components/tasks/monitor-history'
import { Page, PageHeader, Section } from '@/components/layout/page'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AsyncView, EmptyState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useAsync } from '@/hooks/use-async'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useModels } from '@/stores/models'

const PRESETS = [
  { value: '', label: '仅手动运行' },
  { value: '0 * * * *', label: '每小时' },
  { value: '0 9 * * *', label: '每天 09:00' },
  { value: '0 9 * * 1-5', label: '工作日 09:00' },
  { value: '0 9 * * 1', label: '每周一 09:00' },
  { value: 'custom', label: '自定义 Cron…' },
]

const EMPTY_MONITOR: MonitorConfig = { url: '', selector: '', focus: '', condition: '', action: 'notify', prompt: '' }

/** monitors check more often than tasks run */
const MONITOR_PRESETS = [
  { value: '*/5 * * * *', label: '每 5 分钟' },
  { value: '*/15 * * * *', label: '每 15 分钟' },
  { value: '*/30 * * * *', label: '每 30 分钟' },
  { value: '0 * * * *', label: '每小时' },
  { value: '0 9 * * *', label: '每天 09:00' },
  { value: '', label: '仅手动检查' },
  { value: 'custom', label: '自定义 Cron…' },
]

const describeCron = (c?: string | null) => (c ? ([...PRESETS, ...MONITOR_PRESETS].find((p) => p.value === c)?.label ?? `Cron: ${c}`) : '手动')
const hostOf = (url?: string) => {
  try {
    return new URL(url ?? '').host
  } catch {
    return url ?? ''
  }
}

const STATUS: Record<
  TaskRunStatus,
  { label: string; variant: 'success' | 'danger' | 'neutral' | 'primary' | 'warning'; dot: 'success' | 'danger' | 'neutral' | 'running' | 'warning' }
> = {
  queued: { label: '排队中', variant: 'neutral', dot: 'neutral' },
  running: { label: '运行中', variant: 'primary', dot: 'running' },
  success: { label: '成功', variant: 'success', dot: 'success' },
  error: { label: '失败', variant: 'danger', dot: 'danger' },
  cancelled: { label: '已取消', variant: 'warning', dot: 'warning' },
}

type Draft = Omit<Task, 'id' | 'createdAt'> & { id?: string }

function TaskDialog({ task, onClose, onSaved }: { task: Task | null; onClose: () => void; onSaved: () => void }) {
  const models = useModels((s) => s.models) ?? []
  const [d, setD] = useState<Draft>(task ?? { name: '', prompt: '', modelId: null, cron: null, enabled: true, kind: 'agent' })
  const presets = (d.kind ?? 'agent') === 'monitor' ? MONITOR_PRESETS : PRESETS
  const [mode, setMode] = useState(() => (!d.cron ? 'none' : presets.some((p) => p.value === d.cron) ? d.cron : 'custom'))
  const [saving, setSaving] = useState(false)
  const kind = d.kind ?? 'agent'
  const flowsList = useAsync(() => call('macros.list'), [])
  const flow = flowsList.data?.find((x) => x.id === d.macroId)
  const ready = d.name.trim() && (kind === 'flow' ? !!d.macroId : kind === 'monitor' ? /^https?:\/\/\S+$/i.test(d.monitor?.url.trim() ?? '') : d.prompt.trim())
  const setKind = (v: NonNullable<Task['kind']>) => {
    setD({ ...d, kind: v, monitor: v === 'monitor' ? (d.monitor ?? EMPTY_MONITOR) : d.monitor })
    // a new monitor checks every 30 minutes unless told otherwise
    if (v === 'monitor' && mode === 'none' && !task) setMode('*/30 * * * *')
    if (v !== 'monitor' && !PRESETS.some((p) => p.value === mode) && mode !== 'none' && mode !== 'custom') setMode('none')
  }

  const save = async () => {
    setSaving(true)
    try {
      await call('tasks.save', { ...d, cron: mode === 'custom' ? d.cron : mode === 'none' ? null : mode })
      toast.success('任务已保存')
      onSaved()
      onClose()
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={task ? '编辑任务' : '新建任务'}
        description={
          kind === 'monitor' ? '在后台定时查看网页；内容没变不调用模型，有变化才判断是否满足条件。' : '任务在后台以独立会话运行，完成后发送系统通知。'
        }
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={saving} disabled={!ready} onClick={save}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="名称">
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus placeholder="每日资讯摘要" />
          </Field>
          <div className="flex rounded-md border border-border bg-muted p-0.5" role="tablist">
            {(
              [
                ['agent', 'Agent 任务', '由模型理解并完成'],
                ['flow', '固定流程', '按保存的步骤直接回放，不调用模型'],
                ['monitor', '网页监控', '定时查看网页，内容变化且满足条件时提醒'],
              ] as const
            ).map(([v, label, hint]) => (
              <button
                key={v}
                role="tab"
                aria-selected={kind === v}
                title={hint}
                onClick={() => setKind(v)}
                className={cn(
                  'interactive h-8 flex-1 rounded-[5px] text-sm',
                  kind === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {kind === 'monitor' ? (
            <MonitorFields value={d.monitor ?? EMPTY_MONITOR} onChange={(monitor) => setD({ ...d, monitor })} />
          ) : kind === 'agent' ? (
            <Field label="任务描述" hint="像对 Agent 说话一样描述目标和输出要求">
              <Textarea
                value={d.prompt}
                onChange={(e) => setD({ ...d, prompt: e.target.value })}
                rows={5}
                placeholder="打开 Hacker News，总结前 10 篇文章，并把摘要保存到 /workspace/daily/今天日期.md"
              />
            </Field>
          ) : (
            <>
              <Field label="固定流程" hint="按步骤直接回放、不调用模型；某一步因页面改版失效时，由 Agent 完成并自动更新流程">
                <Select
                  value={d.macroId ?? undefined}
                  placeholder={flowsList.data?.length ? '选择流程' : '还没有固定流程：在对话里点「固化流程」，或在录制宏页面录制'}
                  onChange={(v) => setD({ ...d, macroId: v, params: {} })}
                  options={(flowsList.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
                />
              </Field>
              {flow?.params.length ? (
                <div className="grid gap-2">
                  {flow.params.map((p) => (
                    <Field key={p.name} label={p.description || p.name}>
                      <Input
                        value={d.params?.[p.name] ?? ''}
                        placeholder={p.default ? `默认：${p.default}` : ''}
                        type={p.name === 'password' ? 'password' : 'text'}
                        onChange={(e) => setD({ ...d, params: { ...(d.params ?? {}), [p.name]: e.target.value } })}
                      />
                    </Field>
                  ))}
                </div>
              ) : null}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={kind === 'monitor' ? '判断用的模型' : '模型'} className={cn(kind === 'flow' && 'pointer-events-none opacity-50')}>
              <Select
                value={d.modelId ?? 'default'}
                onChange={(v) => setD({ ...d, modelId: v === 'default' ? null : v })}
                options={[{ value: 'default', label: '默认模型' }, ...models.map((m) => ({ value: m.id, label: m.displayName }))]}
              />
            </Field>
            <Field label={kind === 'monitor' ? '检查频率' : '计划'}>
              <Select value={mode} onChange={setMode} options={presets.map((p) => ({ value: p.value === '' ? 'none' : p.value, label: p.label }))} />
            </Field>
          </div>
          {mode === 'custom' ? (
            <Field label="Cron 表达式" hint="分 时 日 月 周，例如 30 8 * * 1-5">
              <Input value={d.cron ?? ''} onChange={(e) => setD({ ...d, cron: e.target.value })} className="font-mono" />
            </Field>
          ) : null}
          <label className="flex items-center justify-between text-sm">
            启用定时计划
            <Switch checked={d.enabled} onCheckedChange={(v) => setD({ ...d, enabled: v })} />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function TasksPage() {
  const tasks = useAsync(() => call('tasks.list'))
  const runs = useAsync(() => call('tasks.runs'))
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const [history, setHistory] = useState<Task | null>(null)
  const monitors = useAsync(() => call('monitor.summary'))
  const loadModels = useModels((s) => s.load)
  const select = useChat((s) => s.select)
  const navigate = useNavigate()

  useEffect(() => {
    void loadModels()
    return on('tasks.changed', () => {
      tasks.reload()
      runs.reload()
      monitors.reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runNow = async (t: Task) => {
    try {
      await call('tasks.run', t.id)
      toast.success(t.kind === 'monitor' ? `正在检查：${t.name}` : `已开始运行：${t.name}`)
    } catch (e) {
      toast.error('运行失败', { description: errorMessage(e) })
    }
  }

  const openThread = (threadId: string) => {
    select(threadId)
    navigate('/chat')
  }

  const taskName = (id: string) => tasks.data?.find((t) => t.id === id)?.name ?? '已删除的任务'

  return (
    <Page>
      <PageHeader
        title="任务"
        description="保存常用的 Agent 任务，手动或按计划在后台运行。"
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus />
            新建任务
          </Button>
        }
      />
      <Section title="我的任务">
        <AsyncView
          state={tasks}
          loading={<ListSkeleton rows={2} />}
          empty={
            <Card>
              <EmptyState
                icon={ListChecks}
                title="还没有任务"
                description="把重复性的工作交给 Agent，例如每天早上汇总资讯、定期检查网站变化。"
                action={
                  <Button variant="primary" onClick={() => setEditing('new')}>
                    新建任务
                  </Button>
                }
              />
            </Card>
          }
        >
          {(list) => (
            <div className="grid gap-2">
              {list.map((t) => (
                <Card key={t.id} className="flex animate-fade-in items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      <Badge variant="outline">
                        <CalendarClock />
                        {describeCron(t.cron)}
                      </Badge>
                      {t.cron && !t.enabled ? <Badge variant="warning">已暂停</Badge> : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {t.kind === 'flow'
                        ? '固定流程 · 直接回放，不调用模型'
                        : t.kind === 'monitor'
                          ? `监控 ${hostOf(t.monitor?.url)} · ${t.monitor?.condition || '有变化就提醒'}`
                          : t.prompt}
                    </p>
                    {t.kind === 'monitor' && monitors.data?.[t.id]?.checks ? (
                      <p data-testid="monitor-summary" className="mt-0.5 truncate text-xs text-subtle-foreground">
                        已检查 {monitors.data[t.id].checks} 次 · 触发 {monitors.data[t.id].triggers} 次
                        {monitors.data[t.id].lastSummary ? ` · 最近：${monitors.data[t.id].lastSummary}` : ''}
                      </p>
                    ) : null}
                  </div>
                  {t.kind === 'monitor' && (monitors.data?.[t.id]?.failStreak ?? 0) >= 2 ? (
                    <Badge variant="danger">连续失败 {monitors.data![t.id].failStreak} 次</Badge>
                  ) : null}
                  {t.lastStatus ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot status={STATUS[t.lastStatus].dot} />
                      {STATUS[t.lastStatus].label} · {timeAgo(t.lastRunAt!)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-subtle-foreground">尚未运行</span>
                  )}
                  {t.kind === 'monitor' ? (
                    <Button variant="ghost" size="sm" onClick={() => setHistory(t)}>
                      <History />
                      记录
                    </Button>
                  ) : null}
                  <Button variant="secondary" size="sm" onClick={() => void runNow(t)}>
                    {t.kind === 'monitor' ? <RefreshCw /> : <Play />}
                    {t.kind === 'monitor' ? '检查' : '运行'}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="更多">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(t)}>
                        <Pencil />
                        编辑
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger onSelect={async () => (await call('tasks.delete', t.id), tasks.reload())}>
                        <Trash2 />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Card>
              ))}
            </div>
          )}
        </AsyncView>
      </Section>

      <Section title="运行记录">
        <AsyncView
          state={runs}
          loading={<ListSkeleton rows={2} />}
          empty={<p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">任务运行后会显示在这里</p>}
        >
          {(list) => (
            <Card className="divide-y divide-border">
              {list.map((r) => {
                const s = STATUS[r.status]
                return (
                  <div key={r.id} className="flex items-center gap-4 px-4 py-2.5">
                    <Badge variant={s.variant} className="w-14 justify-center">
                      {s.label}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{taskName(r.taskId)}</div>
                      <div className="truncate text-xs text-muted-foreground">{r.error ?? r.summary ?? (r.status === 'running' ? '正在执行…' : '')}</div>
                    </div>
                    <span className="shrink-0 text-xs text-subtle-foreground">{timeAgo(r.startedAt)}</span>
                    {r.status === 'running' ? (
                      <Button variant="ghost" size="sm" onClick={() => void call('tasks.cancel', r.id)}>
                        <Square className="size-3 fill-current" />
                        停止
                      </Button>
                    ) : null}
                    {r.threadId ? (
                      <Button variant="ghost" size="sm" onClick={() => openThread(r.threadId)}>
                        <MessageSquare />
                        查看会话
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </Card>
          )}
        </AsyncView>
      </Section>
      {history ? (
        <MonitorHistory
          task={history}
          onClose={() => setHistory(null)}
          onOpenThread={(id) => {
            setHistory(null)
            openThread(id)
          }}
        />
      ) : null}
      {editing ? <TaskDialog task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={tasks.reload} /> : null}
    </Page>
  )
}
