import { Camera, ClipboardList, Maximize2, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { useDraft } from '@/hooks/use-draft'
import { useDrafts, submitDraft } from '@/stores/drafts'
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
  const draft = useDraft({ surface: 'quick', ...(activeId ? { threadId: activeId } : {}) })
  const loadModels = useModels((s) => s.load)
  const runtimeId = thread?.runtimeId ?? (activeId ? 'builtin' : (draft.data?.runtimeId ?? 'builtin'))
  const noModels = useModels((s) => s.activeModels?.length === 0) && (runtimeId === 'builtin' || runtimeId === 'pi')
  const draftModelId = draft.data?.modelId ?? null
  const [clip, setClip] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  const newChat = useCallback(() => {
    useChat.setState({ activeId: null })
    void useDrafts
      .getState()
      .flush(draft.scope)
      .catch(() => undefined)
    setClip(null)
  }, [draft.scope])

  useEffect(() => {
    document.documentElement.classList.add('quick')
    void loadModels()
    void useChat.getState().loadThreads()
    const offs = [
      on('quick.opened', ({ clipboard, fileIds }) => {
        setClip(clipboard)
        if (fileIds.length) {
          const threadId = useChat.getState().activeId
          void useDrafts.getState().addFiles({ surface: 'quick', ...(threadId ? { threadId } : {}) }, fileIds)
        }
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
  }, [loadModels, newChat])

  // follow the answer as it streams
  const lastLength = view?.messages.at(-1)?.content.length
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [view?.messages.length, lastLength, view?.interrupt])

  /** the copied text goes along as a text attachment (parsed like any file) */
  const attachClipboard = async () => {
    if (!clip) return
    try {
      const rec = await call('files.addData', t('剪贴板.txt'), new TextEncoder().encode(clip))
      await useDrafts.getState().addFiles(draft.scope, [rec.id])
      setClip(null)
    } catch (e) {
      toast.error(t('无法添加剪贴板内容'), { description: errorMessage(e) })
    }
  }

  const decide = async (decisions: Decision[], alwaysAllow?: string[]) => {
    if (!activeId) return
    useChat.setState((s) => ({ views: { ...s.views, [activeId]: { ...s.views[activeId], interrupt: null, running: true } } }))
    await call('chat.resume', activeId, decisions, alwaysAllow, view?.interrupt?.id).catch(async (e) => {
      useChat.setState((s) => ({ views: { ...s.views, [activeId]: { ...s.views[activeId], running: false, interrupt: view?.interrupt ?? null } } }))
      await useChat.getState().loadThread(activeId)
      toast.error(t('提交失败'), { description: errorMessage(e) })
    })
  }

  const hasMessages = !!view?.messages.length

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-border bg-background/95 text-foreground shadow-float">
      <header className="drag flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Logo className="size-5" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{thread?.title && hasMessages ? thread.title : t('Navo 快问')}</span>
        <div className="no-drag flex items-center gap-0.5">
          <Tooltip content={t('截图提问')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('截图提问')}
              disabled={runtimeId !== 'builtin' && runtimeId !== 'pi'}
              onClick={() => void call('quick.screenshot')}
            >
              <Camera />
            </Button>
          </Tooltip>
          <Tooltip content={t('新的提问 ⌘N')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('新的提问')} onClick={newChat} disabled={!hasMessages}>
              <Plus />
            </Button>
          </Tooltip>
          <Tooltip content={t('在 Navo 中继续')}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('在 Navo 中继续')}
              onClick={() =>
                void (async () => {
                  await useDrafts.getState().flush(draft.scope)
                  await call('quick.openInMain', activeId, draft.scope)
                })().catch((e) => toast.error(t('操作失败'), { description: errorMessage(e) }))
              }
            >
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
          draftScope={draft.scope}
          runtimeId={runtimeId}
          value={draft.data?.text ?? ''}
          onValueChange={(text) => draft.patch({ text })}
          onSend={async () => {
            const receipt = await submitDraft(draft.scope, { threadId: activeId ?? undefined, modelId: draftModelId ?? thread?.modelId, runtimeId })
            await useChat.getState().loadThreads()
            useChat.getState().select(receipt.threadId)
          }}
          onStop={() => activeId && void call('chat.stop', activeId)}
          running={!!view?.running}
          modelId={draftModelId ?? thread?.modelId ?? null}
          onModelChange={(id) => draft.patch({ modelId: id })}
          showModelManagementLink={false}
          disabled={draft.loading || !!view?.interrupt || (!!activeId && !thread)}
          disabledReason={noModels ? t('请先在 Navo 主窗口的模型页面启用模型') : t('请先处理上方的确认')}
        />
      </div>
    </div>
  )
}
