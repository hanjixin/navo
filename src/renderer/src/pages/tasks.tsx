import { CalendarClock, ListChecks, MessageSquare, MoreHorizontal, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { Task, TaskRun, TaskRunStatus } from '@shared/types'
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
import { errorMessage, timeAgo } from '@/lib/utils'
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

const describeCron = (c?: string | null) => (c ? (PRESETS.find((p) => p.value === c)?.label ?? `Cron: ${c}`) : '手动')

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
  const [d, setD] = useState<Draft>(task ?? { name: '', prompt: '', modelId: null, cron: null, enabled: true })
  const [mode, setMode] = useState(() => (!d.cron ? 'none' : PRESETS.some((p) => p.value === d.cron) ? d.cron : 'custom'))
  const [saving, setSaving] = useState(false)

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
        description="任务在后台以独立会话运行，完成后发送系统通知。"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={saving} disabled={!d.name.trim() || !d.prompt.trim()} onClick={save}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="名称">
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus placeholder="每日资讯摘要" />
          </Field>
          <Field label="任务描述" hint="像对 Agent 说话一样描述目标和输出要求">
            <Textarea
              value={d.prompt}
              onChange={(e) => setD({ ...d, prompt: e.target.value })}
              rows={5}
              placeholder="打开 Hacker News，总结前 10 篇文章，并把摘要保存到 /workspace/daily/今天日期.md"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="模型">
              <Select
                value={d.modelId ?? 'default'}
                onChange={(v) => setD({ ...d, modelId: v === 'default' ? null : v })}
                options={[{ value: 'default', label: '默认模型' }, ...models.map((m) => ({ value: m.id, label: m.displayName }))]}
              />
            </Field>
            <Field label="计划">
              <Select value={mode} onChange={setMode} options={PRESETS.map((p) => ({ value: p.value === '' ? 'none' : p.value, label: p.label }))} />
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
  const loadModels = useModels((s) => s.load)
  const select = useChat((s) => s.select)
  const navigate = useNavigate()

  useEffect(() => {
    void loadModels()
    return on('tasks.changed', () => {
      tasks.reload()
      runs.reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runNow = async (t: Task) => {
    try {
      await call('tasks.run', t.id)
      toast.success(`已开始运行：${t.name}`)
    } catch (e) {
      toast.error('运行失败', { description: errorMessage(e) })
    }
  }

  const openThread = (r: TaskRun) => {
    select(r.threadId)
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
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.prompt}</p>
                  </div>
                  {t.lastStatus ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot status={STATUS[t.lastStatus].dot} />
                      {STATUS[t.lastStatus].label} · {timeAgo(t.lastRunAt!)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-subtle-foreground">尚未运行</span>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => void runNow(t)}>
                    <Play />
                    运行
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
                    <Button variant="ghost" size="sm" onClick={() => openThread(r)}>
                      <MessageSquare />
                      查看会话
                    </Button>
                  </div>
                )
              })}
            </Card>
          )}
        </AsyncView>
      </Section>
      {editing ? <TaskDialog task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={tasks.reload} /> : null}
    </Page>
  )
}
