import { Camera, ClipboardList, Maximize2, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Decision } from '@shared/types'
import { Logo } from '@/components/brand/logo'
import { Composer } from '@/components/chat/composer'
import { InterruptCard } from '@/components/chat/interrupt-card'
import { MessageList } from '@/components/chat/message-list'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useModels } from '@/stores/models'
import { t } from '@shared/i18n'

/**
 * The quick window (global shortcut): ask from anywhere, optionally about what was just copied or a
 * screenshot, and continue in the main window when it grows into a real task.
 */
export function QuickPage() {
  const activeId = useChat((s) => s.activeId)
  const view = useChat((s) => (s.activeId ? s.views[s.activeId] : undefined))
  const thread = useChat((s) => s.threads?.find((t) => t.id === s.activeId))
  const draftFiles = useChat((s) => s.draftFiles)
  const loadModels = useModels((s) => s.load)
  const noModels = useModels((s) => s.models?.length === 0)
  const [clip, setClip] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.classList.add('quick')
    void loadModels()
    void useChat.getState().loadThreads()
    const offs = [
      on('quick.opened', ({ clipboard, fileIds }) => {
        setClip(clipboard)
        if (fileIds.length) useChat.getState().setDraftFiles([...useChat.getState().draftFiles, ...fileIds])
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 30)
      }),
    ]
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void call('quick.hide')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') newChat()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('keydown', onKey)
    }
  }, [loadModels])

  // follow the answer as it streams
  const lastLength = view?.messages.at(-1)?.content.length
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [view?.messages.length, lastLength, view?.interrupt])

  const newChat = () => {
    useChat.setState({ activeId: null })
    useChat.getState().setDraftFiles([])
    setClip(null)
  }

  /** the copied text goes along as a text attachment (parsed like any file) */
  const attachClipboard = async () => {
    if (!clip) return
    try {
      const rec = await call('files.addData', t('剪贴板.txt'), new TextEncoder().encode(clip))
      useChat.getState().setDraftFiles([...draftFiles, rec.id])
      setClip(null)
    } catch (e) {
      toast.error(t('无法添加剪贴板内容'), { description: errorMessage(e) })
    }
  }

  const decide = async (decisions: Decision[], alwaysAllow?: string[]) => {
    if (!activeId) return
    useChat.setState((s) => ({ views: { ...s.views, [activeId]: { ...s.views[activeId], interrupt: null, running: true } } }))
    await call('chat.resume', activeId, decisions, alwaysAllow).catch((e) => toast.error(t('提交失败'), { description: errorMessage(e) }))
  }

  const hasMessages = !!view?.messages.length

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-border bg-background/95 text-foreground shadow-float">
      <header className="drag flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Logo className="size-5" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{thread?.title && hasMessages ? thread.title : t('Navo 快问')}</span>
        <div className="no-drag flex items-center gap-0.5">
          <Tooltip content={t('截图提问')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('截图提问')} onClick={() => void call('quick.screenshot')}>
              <Camera />
            </Button>
          </Tooltip>
          <Tooltip content={t('新的提问 ⌘N')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('新的提问')} onClick={newChat} disabled={!hasMessages}>
              <Plus />
            </Button>
          </Tooltip>
          <Tooltip content={t('在 Navo 中继续')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('在 Navo 中继续')} onClick={() => void call('quick.openInMain', activeId)}>
              <Maximize2 />
            </Button>
          </Tooltip>
          <Tooltip content={t('收起 Esc')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('收起')} onClick={() => void call('quick.hide')}>
              <X />
            </Button>
          </Tooltip>
        </div>
      </header>

      {hasMessages ? (
        <div className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <MessageList messages={view!.messages} running={view!.running} />
          <div ref={bottom} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-sm text-muted-foreground">{t('问点什么，或让 Navo 去网上帮你办件事')}</p>
          <p className="text-xs text-subtle-foreground">{t('回车发送 · Esc 收起 · 需要时可以在 Navo 主窗口继续')}</p>
        </div>
      )}

      <div className="grid shrink-0 gap-2 px-3 pt-1 pb-3">
        {clip ? (
          <button
            onClick={() => void attachClipboard()}
            className="interactive flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:border-input hover:text-foreground"
          >
            <ClipboardList className="size-3.5 shrink-0" />
            <span className="shrink-0">{t('问刚复制的内容：')}</span>
            <span className="min-w-0 truncate text-subtle-foreground">{clip.replace(/\s+/g, ' ').slice(0, 120)}</span>
          </button>
        ) : null}
        {view?.interrupt ? <InterruptCard interrupt={view.interrupt} onDecide={decide} /> : null}
        <Composer
          onSend={(t, fileIds) => void useChat.getState().send(t, [], fileIds)}
          onStop={() => activeId && void call('chat.stop', activeId)}
          running={!!view?.running}
          modelId={thread?.modelId ?? null}
          onModelChange={(id) => activeId && void call('threads.setModel', activeId, id)}
          disabled={noModels || !!view?.interrupt}
          disabledReason={noModels ? t('请先在 Navo 主窗口配置模型') : t('请先处理上方的确认')}
        />
      </div>
    </div>
  )
}
