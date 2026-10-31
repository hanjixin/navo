import { useEffect, useState, type ReactNode } from 'react'
import type { ComputerUseStatus, Settings } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { openExtensionGuide } from '@/lib/extension-guide'
import { call, on } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

function Row({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-8 px-5 py-4', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Computer use: letting the agent work in the user's own browser. */
export function ComputerUseSection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<void> }) {
  const cfg = settings.computerUse
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  useEffect(() => {
    void call('computerUse.status').then(setStatus)
    return on('computerUse.changed', setStatus)
  }, [])
  const b = status?.browser
  const state = !b ? '' : b.paired ? t('已连接 {{v0}}', { v0: b.browser ?? '' }) : b.pairingCode ? t('等待你确认配对码') : t('未连接')

  return (
    <>
      <h2 className="mb-2 text-sm font-semibold">{t('电脑操作')}</h2>
      <Card className="mb-8 divide-y divide-border" data-testid="computer-use-settings">
        <Row title={t('使用我的浏览器')} description={t('让 Agent 在你自己的 Chrome / Edge 里操作，用上已登录的账号和插件。需要先导入 Navo 浏览器扩展')}>
          <Switch checked={cfg.myBrowser} onCheckedChange={(v) => void patch({ computerUse: { ...cfg, myBrowser: v } })} />
        </Row>
        {cfg.myBrowser ? (
          <Row
            title={t('浏览器扩展')}
            description={
              <span data-testid="extension-state" className={cn(b?.paired && 'text-success')}>
                {state}
              </span>
            }
          >
            <Button size="sm" onClick={openExtensionGuide}>
              {b?.paired ? t('重新导入') : t('导入扩展')}
            </Button>
          </Row>
        ) : null}
      </Card>
    </>
  )
}
