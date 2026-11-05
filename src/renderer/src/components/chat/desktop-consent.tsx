import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { ComputerUseStatus, DesktopConsentDecision, DesktopConsentRequest } from '@shared/types'
import type { DesktopStopReason } from '@shared/control-state'
import { Button } from '@/components/ui/button'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'
import { useChat } from '@/stores/chat'

const stopText = (reason: DesktopStopReason) =>
  ({
    user_takeover: t('你已接管电脑，桌面操作已暂停'),
    user_stop: t('桌面操作已停止'),
    authorization_revoked: t('桌面授权已撤销'),
    permission_missing: t('桌面权限不足，请检查系统权限'),
    service_failure: t('桌面控制服务异常，请检查状态'),
  })[reason]

export function DesktopConsentCard({ request, onResolved, onHide }: { request: DesktopConsentRequest; onResolved?: () => void; onHide?: () => void }) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const deciding = useRef(false)
  const decide = async (decision: DesktopConsentDecision) => {
    if (deciding.current) return
    deciding.current = true
    setPending(true)
    setError('')
    try {
      await call('computerUse.consent', request.id, decision)
      onResolved?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      deciding.current = false
      setPending(false)
    }
  }
  return (
    <section data-testid="desktop-consent" aria-label={t('允许操作这个应用吗？')} className="rounded-lg border border-warning/40 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t('允许操作这个应用吗？')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('Agent 请求在当前对话中读取和操作 {{v0}}。', { v0: request.app })}</p>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{request.bundleId}</p>
        </div>
        {onHide ? (
          <Button size="sm" variant="ghost" onClick={onHide}>
            {t('稍后处理')}
          </Button>
        ) : null}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t('本次任务授权在任务结束后失效；你可以随时在确认中心撤销授权。')}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" disabled={pending} onClick={() => void decide('deny')}>
          {t('拒绝')}
        </Button>
        <Button size="sm" disabled={pending} onClick={() => void decide('once')}>
          {t('仅这一次')}
        </Button>
        <Button size="sm" disabled={pending} onClick={() => void decide('session')}>
          {t('本对话允许')}
        </Button>
        <Button size="sm" variant="primary" disabled={pending} onClick={() => void decide('execution')}>
          {t('本次任务允许')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/** Inline in the current conversation; hiding leaves the request in the confirmation inbox. */
export function DesktopConsentInline() {
  const threadId = useChat((s) => s.activeId)
  const [requests, setRequests] = useState<DesktopConsentRequest[]>([])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    let alive = true,
      version = 0
    const refresh = () => {
      const request = ++version
      void call('computerUse.consents')
        .then((items) => {
          if (alive && request === version) setRequests(items)
        })
        .catch(() => {})
    }
    refresh()
    const off = on('computerUse.consent', refresh)
    return () => {
      alive = false
      off()
    }
  }, [])
  const request = requests.find((item) => item.threadId === threadId && !hidden.has(item.id))
  return request ? (
    <DesktopConsentCard
      key={request.id}
      request={request}
      onHide={() => setHidden((ids) => new Set(ids).add(request.id))}
      onResolved={() => setRequests((items) => items.filter((item) => item.id !== request.id))}
    />
  ) : null
}

/** A global control/stop indicator, never an automatically focused approval dialog. */
export function DesktopConsentHost() {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const navigate = useNavigate()
  const select = useChat((s) => s.select)
  useEffect(() => {
    let alive = true,
      changed = false
    void call('computerUse.status')
      .then((value) => {
        if (alive && !changed) setStatus(value)
      })
      .catch(() => {})
    const off = on('computerUse.changed', (value) => {
      changed = true
      setStatus(value)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  const run = async (action: () => Promise<unknown>) => {
    setPending(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }
  const active = status?.desktop.active
  const stopped = status?.desktop.lastStop
  if (!active && (!stopped || dismissed === stopped.at)) return null
  return (
    <div
      role="status"
      data-testid="desktop-control-bar"
      className="fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-32px)] items-center gap-4 rounded-lg border border-border bg-popover px-4 py-3 shadow-float"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{active ? t('正在操作 {{v0}}', { v0: active.app }) : stopText(stopped!.reason)}</p>
        {active ? <p className="text-xs text-muted-foreground">{t('按 Esc 或移动鼠标可立即停止')}</p> : null}
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {active ? (
        <Button variant="danger" loading={pending} onClick={() => void run(() => call('computerUse.stop'))}>
          {t('停止操作')}
        </Button>
      ) : (
        <>
          {stopped?.reason === 'permission_missing' || stopped?.reason === 'service_failure' ? (
            <Button
              size="sm"
              loading={pending}
              onClick={() =>
                void run(async () => {
                  setStatus(await call('computerUse.refreshDesktop'))
                })
              }
            >
              {t('检查状态')}
            </Button>
          ) : null}
          {stopped?.threadId ? (
            <Button
              size="sm"
              onClick={() => {
                select(stopped.threadId!)
                navigate(`/chat/${encodeURIComponent(stopped.threadId!)}`)
                setDismissed(stopped.at)
              }}
            >
              {t('查看会话')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setDismissed(stopped!.at)}>
            {t('关闭')}
          </Button>
        </>
      )}
    </div>
  )
}
