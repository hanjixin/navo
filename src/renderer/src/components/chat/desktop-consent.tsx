import { useEffect, useRef, useState } from 'react'
import type { ComputerUseStatus, DesktopConsentRequest } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'
import { useChat } from '@/stores/chat'

/** A permission request belongs to its conversation; stopping the run dismisses it globally. */
export function DesktopConsentHost() {
  const [request, setRequest] = useState<DesktopConsentRequest | null>(null)
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const deciding = useRef<string | null>(null)
  const threadTitle = useChat((s) => s.threads?.find((thread) => thread.id === request?.threadId)?.title)
  useEffect(() => {
    let alive = true
    void call('computerUse.status')
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err))
      })
    const offStatus = on('computerUse.changed', setStatus)
    let consentChanged = false
    const offConsent = on('computerUse.consent', (next) => {
      consentChanged = true
      setRequest(next)
      setError('')
    })
    void call('computerUse.pendingConsent')
      .then((next) => {
        if (alive && !consentChanged) setRequest(next)
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err))
      })
    return () => {
      alive = false
      offStatus()
      offConsent()
    }
  }, [])

  const decide = async (decision: 'session' | 'once' | 'deny') => {
    if (!request || deciding.current === request.id) return
    const id = request.id
    deciding.current = id
    setPending(id)
    setError('')
    try {
      await call('computerUse.consent', id, decision)
      setRequest((current) => (current?.id === id ? null : current))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      if (deciding.current === id) deciding.current = null
      setPending((current) => (current === id ? null : current))
    }
  }
  const stop = async () => {
    setStopping(true)
    setError('')
    try {
      await call('computerUse.stop')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStopping(false)
    }
  }
  const active = status?.desktop?.active
  return (
    <>
      {active ? (
        <div
          role="status"
          data-testid="desktop-control-bar"
          className="fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-32px)] items-center gap-4 rounded-lg border border-border bg-popover px-4 py-3 shadow-float"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{t('正在操作 {{v0}}', { v0: active.app })}</p>
            <p className="text-xs text-muted-foreground">{t('按 Esc 或移动鼠标可立即停止')}</p>
            {error && !request ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <Button variant="danger" loading={stopping} onClick={() => void stop()}>
            {t('停止操作')}
          </Button>
        </div>
      ) : null}
      {request ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) void decide('deny')
          }}
        >
          <DialogContent
            title={t('允许操作这个应用吗？')}
            description={t('Agent 请求在当前对话中读取和操作 {{v0}}。', { v0: request.app })}
            data-testid="desktop-consent"
            footer={
              <>
                <Button disabled={pending === request.id} onClick={() => void decide('deny')}>
                  {t('拒绝')}
                </Button>
                <Button disabled={pending === request.id} onClick={() => void decide('once')}>
                  {t('仅这一次')}
                </Button>
                <Button variant="primary" disabled={pending === request.id} onClick={() => void decide('session')}>
                  {t('本对话允许')}
                </Button>
              </>
            }
          >
            <p className="text-sm font-medium">{request.app}</p>
            {threadTitle ? <p className="mt-1 text-sm text-muted-foreground">{threadTitle}</p> : null}
            <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{request.bundleId}</p>
            <p className="mt-4 text-sm text-muted-foreground">{t('你可以随时按 Esc、移动鼠标或点击停止操作。')}</p>
            {error ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
