import { Bell, ChevronRight, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { PendingInterrupt, Thread } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/states'
import { call, on } from '@/lib/ipc'
import { useChat } from '@/stores/chat'
import { t } from '@shared/i18n'

interface ApprovalItem {
  thread: Thread
  interrupt: PendingInterrupt
}

/** A single inbox for confirmations that would otherwise be hidden in a conversation. */
export function ApprovalCenter() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const select = useChat((s) => s.select)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const threads = await call('threads.list')
      const states = await Promise.all(
        threads.map(async (thread) => {
          try {
            const state = await call('threads.state', thread.id)
            return state.interrupt ? { thread, interrupt: state.interrupt } : null
          } catch {
            return null
          }
        }),
      )
      setItems(states.filter((x): x is ApprovalItem => !!x))
    } catch {
      // The current conversation still shows its own approval card if this inbox is unavailable.
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      void refresh()
    }, 120)
  }, [refresh])

  useEffect(() => {
    void refresh()
    const offChat = on('chat.event', (event) => {
      if (event.type === 'interrupt' || event.type === 'run_end' || event.type === 'error') scheduleRefresh()
    })
    const offThreads = on('threads.changed', scheduleRefresh)
    return () => {
      offChat()
      offThreads()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [refresh, scheduleRefresh])

  const openThread = (id: string) => {
    setOpen(false)
    select(id)
    navigate(`/chat/${encodeURIComponent(id)}`)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="relative h-7 gap-1.5 px-2 text-xs text-muted-foreground"
        aria-label={items.length ? t('有 {{v0}} 个待确认操作', { v0: items.length }) : t('确认中心')}
        onClick={() => setOpen(true)}
      >
        <Bell className="size-3.5" />
        <span className="hidden lg:inline">{t('确认')}</span>
        {items.length ? (
          <span className="text-warning-foreground flex size-4 items-center justify-center rounded-full bg-warning text-[10px] font-semibold">
            {items.length}
          </span>
        ) : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={t('确认中心')} description={t('需要你决定的邮件、消息、桌面和其他高风险操作。')} className="w-[min(560px,calc(100vw-48px))]">
          {!items.length ? (
            <EmptyState icon={ShieldAlert} title={t('没有待确认操作')} description={t('需要授权的操作会出现在这里。')} />
          ) : (
            <div className="grid gap-2">
              {items.map(({ thread, interrupt }) => (
                <button
                  key={thread.id}
                  className="interactive flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left hover:bg-accent"
                  onClick={() => openThread(thread.id)}
                >
                  <ShieldAlert className="size-4 shrink-0 text-warning" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{thread.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t('{{v0}} 个操作等待确认', { v0: interrupt.actionRequests.length })}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
