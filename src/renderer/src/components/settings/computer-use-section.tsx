import { useEffect, useState, type ReactNode } from 'react'
import type { ComputerUseStatus, Settings } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { openExtensionGuide } from '@/lib/extension-guide'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'
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

function BlockedApps({ value, save, windows }: { value: string[]; save: (apps: string[]) => Promise<void>; windows: boolean }) {
  const [text, setText] = useState(value.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const apps = [
    ...new Set(
      text
        .split(windows ? /\n/ : /[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
  const changed = apps.join('\n') !== value.join('\n')
  return (
    <div className="px-5 py-4">
      <label htmlFor="desktop-blocked-apps" className="text-sm font-medium">
        {t('禁止操作的应用')}
      </label>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {windows ? t('每行填写一个应用的 exe 完整路径。列表中的应用始终禁止操作。') : t('每行填写一个应用的 Bundle ID。列表中的应用始终禁止操作。')}
      </p>
      <textarea
        id="desktop-blocked-apps"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        spellCheck={false}
        className="mt-3 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="mt-2 flex items-center justify-end gap-3">
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <Button
          size="sm"
          disabled={!changed}
          loading={saving}
          onClick={() => {
            setSaving(true)
            setError('')
            void save(apps)
              .catch((err) => setError(errorMessage(err)))
              .finally(() => setSaving(false))
          }}
        >
          {t('保存')}
        </Button>
      </div>
    </div>
  )
}

/** Settings and permission status for browser and desktop control. */
export function ComputerUseSection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<void> }) {
  const cfg = settings.computerUse
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void call('computerUse.status')
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch((err) => {
        if (alive) setRefreshError(errorMessage(err))
      })
    const off = on('computerUse.changed', setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])
  useEffect(() => {
    if (!cfg.desktop) return
    let alive = true
    let refreshing = false
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const s = await call('computerUse.refreshDesktop')
        if (alive) {
          setStatus(s)
          setRefreshError('')
        }
      } catch (err) {
        if (alive) setRefreshError(errorMessage(err))
      } finally {
        refreshing = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [cfg.desktop])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const b = status?.browser
  const d = status?.desktop
  const windows = d?.platform === 'win32'
  const state = !b ? '' : b.paired ? t('已连接 {{v0}}', { v0: b.browser ?? '' }) : b.pairingCode ? t('等待你确认配对码') : t('未连接')

  return (
    <>
      <h2 className="mb-2 text-sm font-semibold">{t('电脑操作')}</h2>
      <Card className="mb-8 divide-y divide-border" data-testid="computer-use-settings">
        <Row title={t('使用我的浏览器')} description={t('让 Agent 在你自己的 Chrome / Edge 里操作，用上已登录的账号和插件。需要先导入 Navo 浏览器扩展')}>
          <Switch
            aria-label={t('使用我的浏览器')}
            checked={cfg.myBrowser}
            disabled={busy}
            onCheckedChange={(v) => void run(() => patch({ computerUse: { ...cfg, myBrowser: v } }))}
          />
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
        <Row
          title={t('操作桌面应用')}
          description={
            d?.supported === false ? t('桌面应用操作需要 macOS 14+ 或 Windows 10/11。') : t('让 Agent 操作电脑上的应用。首次操作每个应用前，会先征求你的同意。')
          }
        >
          <Switch
            aria-label={t('操作桌面应用')}
            data-testid="desktop-enabled"
            checked={cfg.desktop}
            disabled={busy || d?.supported === false}
            onCheckedChange={(v) => void run(() => patch({ computerUse: { ...cfg, desktop: v } }))}
          />
        </Row>
        {cfg.desktop && d?.supported ? (
          <>
            {windows ? (
              <Row title={t('Windows 桌面访问')} description={t('无需额外的系统权限开关。支持普通权限应用；锁屏、UAC 提示和管理员应用不可操作。')}>
                <span className={cn('text-xs', d.accessibility && d.screenRecording ? 'text-success' : 'text-muted-foreground')}>
                  {d.accessibility && d.screenRecording ? t('可用') : t('当前桌面不可用')}
                </span>
              </Row>
            ) : (
              <>
                <Row title={t('辅助功能')} description={d.accessibility ? t('已授权') : t('允许 Navo 点击、输入和读取应用界面。')}>
                  {d.accessibility ? (
                    <span className="text-xs text-success">{t('已授权')}</span>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => void run(() => call('computerUse.openPermission', 'accessibility'))}>
                      {t('前往授权')}
                    </Button>
                  )}
                </Row>
                <Row title={t('屏幕录制')} description={d.screenRecording ? t('已授权') : t('允许 Navo 截取应用窗口。授权后可能需要重新启动 Navo。')}>
                  {d.screenRecording ? (
                    <span className="text-xs text-success">{t('已授权')}</span>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => void run(() => call('computerUse.openPermission', 'screenRecording'))}>
                      {t('前往授权')}
                    </Button>
                  )}
                </Row>
              </>
            )}
            <Row
              title={t('桌面控制服务')}
              description={
                d.helper === 'ok'
                  ? t('运行正常')
                  : d.helper === 'missing'
                    ? t('缺少桌面控制组件，请重新安装 Navo。')
                    : t('桌面控制服务异常，请尝试重新启动 Navo。')
              }
            >
              <Button
                size="sm"
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await call('computerUse.restart')
                  })
                }
              >
                {t('重新启动 Navo')}
              </Button>
            </Row>
            <BlockedApps
              key={cfg.blockedApps.join('\n')}
              value={cfg.blockedApps}
              windows={windows}
              save={(blockedApps) => patch({ computerUse: { ...cfg, blockedApps } })}
            />
          </>
        ) : null}
        {error || refreshError ? (
          <p role="alert" className="px-5 py-3 text-xs text-danger">
            {error || refreshError}
          </p>
        ) : null}
      </Card>
    </>
  )
}
