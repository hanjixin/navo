import { ChevronRight, MessageSquare, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { MonitorCheck, Task } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { AsyncView, EmptyState, ListSkeleton } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { t } from '@shared/i18n'

function status(c: MonitorCheck): { label: string; variant: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' } {
  if (c.error) return { label: t('失败'), variant: 'danger' }
  if (c.first) return { label: t('开始监控'), variant: 'neutral' }
  if (c.triggered) return { label: t('已触发'), variant: 'success' }
  if (c.changed) return { label: t('有变化'), variant: 'primary' }
  return { label: t('无变化'), variant: 'neutral' }
}

function CheckItem({ c, onOpenThread }: { c: MonitorCheck; onOpenThread: (id: string) => void }) {
  const [open, setOpen] = useState(c.triggered)
  const s = status(c)
  const hasDiff = c.added.length > 0 || c.removed.length > 0
  return (
    <li data-testid="monitor-check" className="grid gap-1.5 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Badge variant={s.variant} className="w-16 justify-center">
          {s.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm">
          {c.error ?? c.summary ?? (c.repeats > 1 ? t('连续 {{v0}} 次检查内容都没变，没有调用模型', { v0: c.repeats }) : t('内容与上次相同，没有调用模型'))}
        </span>
        <span
          className="shrink-0 text-xs text-subtle-foreground"
          title={c.repeats > 1 ? `${new Date(c.at).toLocaleString()} – ${new Date(c.lastAt).toLocaleString()}` : new Date(c.at).toLocaleString()}
        >
          {timeAgo(c.lastAt)}
        </span>
      </div>
      {hasDiff || c.threadId ? (
        <div className="flex items-center gap-1 pl-[72px]">
          {hasDiff ? (
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => setOpen(!open)} aria-expanded={open}>
              <ChevronRight className={cn('transition-transform duration-150', open && 'rotate-90')} />
              {t('变化内容')}
            </Button>
          ) : null}
          {c.threadId ? (
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => onOpenThread(c.threadId!)}>
              <MessageSquare />
              {t('Agent 的处理')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {open && hasDiff ? (
        <div
          data-testid="monitor-diff"
          className="selectable ml-[72px] grid animate-fade-in gap-px overflow-hidden rounded-md border border-border font-mono text-xs"
        >
          {c.removed.slice(0, 30).map((l, i) => (
            <div key={`r${i}`} className="truncate bg-danger-soft px-2 py-0.5 text-danger" title={l}>
              − {l}
            </div>
          ))}
          {c.added.slice(0, 30).map((l, i) => (
            <div key={`a${i}`} className="truncate bg-success-soft px-2 py-0.5 text-success" title={l}>
              + {l}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** A monitor's checks: when it looked, what changed, what it decided. */
export function MonitorHistory({ task, onClose, onOpenThread }: { task: Task; onClose: () => void; onOpenThread: (id: string) => void }) {
  const checks = useAsync(() => call('monitor.checks', task.id, 100), [task.id])
  const [checking, setChecking] = useState(false)

  useEffect(
    () =>
      on('monitor.checked', ({ taskId }) => {
        if (taskId === task.id) checks.reload()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id],
  )

  const checkNow = async () => {
    setChecking(true)
    try {
      const c = await call('monitor.check', task.id)
      if (c.error) toast.error(t('检查失败'), { description: c.error })
    } catch (e) {
      toast.error(t('检查失败'), { description: errorMessage(e) })
    } finally {
      setChecking(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t('监控记录 · {{v0}}', { v0: task.name })} description={task.monitor?.url} className="w-[min(680px,calc(100vw-48px))]">
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {task.monitor?.condition ? t('条件：{{v0}}', { v0: task.monitor.condition }) : t('条件：内容有实质变化')}
          </span>
          <Button variant="secondary" size="sm" loading={checking} onClick={() => void checkNow()}>
            {!checking ? <RefreshCw /> : null}
            {t('现在检查')}
          </Button>
        </div>
        <AsyncView
          state={checks}
          loading={<ListSkeleton rows={3} />}
          empty={<EmptyState icon={RefreshCw} title={t('还没有检查过')} description={t('按计划自动检查，也可以点「现在检查」。第一次检查会记下当前内容。')} />}
        >
          {(list) => (
            <ul className="max-h-[52vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {list.map((c) => (
                <CheckItem key={c.id} c={c} onOpenThread={onOpenThread} />
              ))}
            </ul>
          )}
        </AsyncView>
      </DialogContent>
    </Dialog>
  )
}
