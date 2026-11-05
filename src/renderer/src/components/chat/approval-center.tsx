import { Bell, ChevronRight, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { DesktopGrant, UnifiedApproval } from '@shared/control-state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/states'
import { call, on } from '@/lib/ipc'
import { useChat } from '@/stores/chat'
import { errorMessage } from '@/lib/utils'
import { DesktopConsentCard } from './desktop-consent'
import { t } from '@shared/i18n'

/** Reads the approval index, never complete conversation histories. */
export function ApprovalCenter() {
  const [items, setItems] = useState<UnifiedApproval[]>([])
  const [grants, setGrants] = useState<DesktopGrant[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<string | null>(null)
  const navigate = useNavigate()
  const select = useChat((s) => s.select)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const version = useRef(0)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    const request = ++version.current
    try {
      const [next, allowed] = await Promise.all([call('approvals.list'), call('computerUse.grants')])
      if (alive.current && request === version.current) {
        setItems(next)
        setGrants(allowed)
        setError('')
      }
    } catch (err) {
      if (alive.current && request === version.current) setError(errorMessage(err))
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
    alive.current = true
    void refresh()
    const off = on('approvals.changed', scheduleRefresh)
    const offConsent = on('computerUse.consent', scheduleRefresh)
    const offThreads = on('threads.changed', scheduleRefresh)
    return () => {
      alive.current = false
      off()
      offConsent()
      offThreads()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [refresh, scheduleRefresh])
  const openThread = (id: string) => {
    setOpen(false)
    select(id)
    navigate(`/chat/${encodeURIComponent(id)}`)
  }
  const revoke = async (id: string) => {
    if (revoking) return
    setRevoking(id)
    try {
      await call('computerUse.revokeGrant', id)
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRevoking(null)
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="relative h-7 gap-1.5 px-2 text-xs text-muted-foreground"
        aria-label={items.length ? t('有 {{v0}} 个待确认操作', { v0: items.length }) : t('确认中心')}
        onClick={() => {
          setOpen(true)
          void refresh()
        }}
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
        <DialogContent title={t('确认中心')} description={t('需要你决定的邮件、消息、桌面和其他高风险操作。')} className="w-[min(640px,calc(100vw-48px))]">
          {error ? (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
          {!items.length ? (
            <EmptyState icon={ShieldAlert} title={t('没有待确认操作')} description={t('需要授权的操作会出现在这里。')} />
          ) : (
            <div className="grid gap-2">
              {items.map((item) =>
                item.kind === 'desktop' ? (
                  <div key={item.id}>
                    <button className="mb-1 text-sm text-primary" onClick={() => openThread(item.threadId)}>
                      {item.threadTitle}
                    </button>
                    <DesktopConsentCard request={item.request} onResolved={() => void refresh()} />
                  </div>
                ) : (
                  <button
                    key={`${item.threadId}:${item.executionId}`}
                    className="interactive flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left hover:bg-accent"
                    onClick={() => openThread(item.threadId)}
                  >
                    <ShieldAlert className="size-4 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.threadTitle}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('{{v0}} 个操作等待确认', { v0: item.interrupt.actionRequests.length })}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ),
              )}
            </div>
          )}
          {grants.length ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-sm font-medium">{t('已允许的桌面操作')}</p>
              <div className="grid gap-2">
                {grants.map((grant) => (
                  <div key={grant.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {grant.app} · {grant.scope === 'execution' ? t('本次任务允许') : t('本对话允许')}
                      </p>
                      <button className="text-xs text-primary" onClick={() => openThread(grant.threadId)}>
                        {t('查看会话')}
                      </button>
                    </div>
                    <Button size="sm" disabled={!!revoking} onClick={() => void revoke(grant.id)}>
                      {t('撤销授权')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
