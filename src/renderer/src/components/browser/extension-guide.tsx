import { Check, Copy, FolderInput, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ComputerUseStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { OPEN_EXTENSION_GUIDE } from '@/lib/extension-guide'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-sm font-medium">{title}</div>
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
    </li>
  )
}

/** Importing the Navo extension ("Load unpacked"), then confirming its pairing code. */
export function ExtensionGuide({ status, onClose }: { status: ComputerUseStatus; onClose: () => void }) {
  const b = status.browser
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // paired: say so briefly, then get out of the way
  useEffect(() => {
    if (!b.paired) return
    const timer = setTimeout(onClose, 1500)
    return () => clearTimeout(timer)
  }, [b.paired, onClose])

  const open = async (browser: 'chrome' | 'edge') => {
    try {
      const r = await call('computerUse.openExtensionsPage', browser)
      if (!r.opened) setManualUrl(r.url)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  const exportTo = async () => {
    try {
      const r = await call('computerUse.exportExtension')
      if (r) toast.success(t('已导出到 {{v0}}', { v0: r.dir }))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  const pair = (approve: boolean) => void call('computerUse.confirmPairing', approve)

  if (b.paired)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent title={t('已连接你的浏览器')}>
          <p className="text-sm" data-testid="extension-paired">
            {t('已连接 {{v0}}。Agent 现在可以在你的浏览器里操作它自己打开的标签页，以及你交给它的标签页。', { v0: b.browser ?? '' })}
          </p>
        </DialogContent>
      </Dialog>
    )

  if (b.pairingCode)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          title={t('确认连接浏览器扩展')}
          footer={
            <>
              <Button onClick={() => pair(false)}>{t('拒绝')}</Button>
              <Button variant="primary" onClick={() => pair(true)}>
                {t('确认连接')}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t('浏览器扩展请求连接 Navo。请确认扩展弹出页里显示的配对码与下面一致：')}</p>
          <div className="my-4 text-center font-mono text-3xl font-semibold tracking-[0.3em]" data-testid="pairing-code">
            {b.pairingCode}
          </div>
          {b.browser ? <p className="text-center text-xs text-muted-foreground">{b.browser}</p> : null}
        </DialogContent>
      </Dialog>
    )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t('导入 Navo 浏览器扩展')} description={t('导入后，Agent 可以在你自己的 Chrome / Edge 里干活，用上已登录的账号和插件。')}>
        <ol className="grid gap-5" data-testid="extension-guide">
          <Step n={1} title={t('在浏览器里打开扩展程序页面')}>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void open('chrome')}>
                {t('在 Chrome 中打开')}
              </Button>
              <Button size="sm" onClick={() => void open('edge')}>
                {t('在 Edge 中打开')}
              </Button>
            </div>
            {manualUrl ? (
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t('没能自动打开，请在地址栏输入')}</span>
                <code className="selectable rounded bg-muted px-1.5 py-0.5">{manualUrl}</code>
                <Button size="icon-sm" variant="ghost" aria-label={t('复制')} onClick={() => void copy(manualUrl)}>
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            ) : null}
          </Step>
          <Step n={2} title={t('打开右上角的「开发者模式」')} />
          <Step n={3} title={t('点「加载已解压的扩展程序」，选择这个文件夹')}>
            <div className="flex items-center gap-2">
              <code className="selectable min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="extension-dir">
                {b.extensionDir}
              </code>
              <Button size="icon-sm" variant="ghost" aria-label={t('复制路径')} onClick={() => void copy(b.extensionDir)}>
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void exportTo()}>
                <FolderInput />
                {t('导出到其他文件夹…')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void call('app.showItemInFolder', b.extensionDir)}>
                <FolderOpen />
                {t('在访达中显示')}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('选择框里找不到这个文件夹时，按 ⌘⇧G 粘贴上面的路径；也可以先导出到桌面等容易找到的地方。')}</p>
          </Step>
        </ol>
        <p className="mt-5 text-xs text-muted-foreground">
          {t('如果浏览器启动时提示停用开发者模式扩展，点关闭即可，扩展会继续可用。需要上传文件时，请在扩展详情里打开「允许访问文件网址」。')}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {b.connected ? t('扩展已连接，等待配对…') : t('导入完成后扩展会自动连接 Navo，这里会请你确认配对码。')}
        </p>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Shows the guide when the user or the agent asked for the user's browser without the extension, and the
 * pairing confirmation whenever the extension asks to pair.
 */
export function ExtensionGuideHost() {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void call('computerUse.status').then(setStatus)
    const offChanged = on('computerUse.changed', (s) => {
      setStatus(s)
      if (s.browser.pairingCode) setOpen(true)
    })
    const show = () => {
      void call('computerUse.installExtension')
        .catch((err) => toast.error(errorMessage(err)))
        .then(() => call('computerUse.status'))
        .then((s) => {
          if (s) setStatus(s)
          setOpen(true)
        })
    }
    const offGuide = on('computerUse.guide', show)
    window.addEventListener(OPEN_EXTENSION_GUIDE, show)
    return () => {
      offChanged()
      offGuide()
      window.removeEventListener(OPEN_EXTENSION_GUIDE, show)
    }
  }, [])

  return open && status ? <ExtensionGuide status={status} onClose={() => setOpen(false)} /> : null
}
