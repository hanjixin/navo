import { ArrowUp, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { AttachmentChip } from '@/components/files/attachment-chip'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { cn, errorMessage } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useFiles } from '@/stores/files'
import { useModels } from '@/stores/models'
import { useSettings } from '@/stores/settings'
import { useVoice } from '@/hooks/use-voice'

export function Composer({
  onSend,
  onStop,
  running,
  modelId,
  onModelChange,
  disabled,
  disabledReason,
}: {
  onSend: (text: string, fileIds: string[]) => void
  onStop: () => void
  running: boolean
  modelId: string | null
  onModelChange: (id: string) => void
  disabled?: boolean
  disabledReason?: string
}) {
  const [text, setText] = useState('')
  const attached = useChat((s) => s.draftFiles)
  const setAttached = useChat((s) => s.setDraftFiles)
  const { addFiles: upload, pick } = useFiles()
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const models = useModels((s) => s.models) ?? []
  const current = models.find((m) => m.id === modelId) ?? models.find((m) => m.isDefault)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const submit = (override?: string) => {
    const t = (override ?? text).trim()
    if ((!t && !attached.length) || running || disabled) return
    onSend(t, attached)
    setText('')
    setAttached([])
  }

  // ---------- voice input
  const autoSend = useSettings((s) => s.settings?.voice.autoSend ?? false)
  const loadSettings = useSettings((s) => s.load)
  const hasSettings = useSettings((s) => !!s.settings)
  useEffect(() => {
    if (!hasSettings) void loadSettings()
  }, [hasSettings, loadSettings])
  const voice = useVoice((said) => {
    const next = text.trim() ? `${text.trimEnd()} ${said}` : said
    if (autoSend && !running) submit(next)
    else {
      setText(next)
      requestAnimationFrame(() => ref.current?.focus())
    }
  })
  const press = useRef({ at: 0, started: false })
  /** holding records until release; a tap starts, the next tap stops */
  const micDown = () => {
    press.current = { at: Date.now(), started: voice.state === 'idle' }
    if (press.current.started) void voice.start()
  }
  const micUp = () => {
    const { at, started } = press.current
    press.current = { at: 0, started: false }
    if (!at) return
    // the press that started it: stop only if it was held; any later press: stop
    if (!started || Date.now() - at > 400) void voice.stop()
  }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (disabled) return
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        if (voice.state === 'idle') void voice.start()
        else if (voice.state === 'recording') void voice.stop()
      } else if (e.key === 'Escape' && voice.state === 'recording') voice.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled, voice])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const attach = (ids: string[]) => setAttached([...useChat.getState().draftFiles, ...ids.filter((id) => !useChat.getState().draftFiles.includes(id))])

  /** Any file type: parsed in the background while the user keeps typing. */
  const addFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? [])
    if (!list.length) return
    try {
      attach((await upload(list)).map((r) => r.id))
    } catch (e) {
      toast.error('添加文件失败', { description: errorMessage(e) })
    }
  }

  return (
    <div
      className={cn(
        'interactive rounded-lg border bg-card focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring',
        dragging ? 'border-primary bg-info-soft' : 'border-input',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void addFiles(e.dataTransfer.files)
      }}
    >
      {attached.length ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attached.map((id) => (
            <AttachmentChip key={id} id={id} onRemove={() => setAttached(attached.filter((x) => x !== id))} />
          ))}
        </div>
      ) : null}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault()
            void addFiles(e.clipboardData.files)
          }
        }}
        disabled={disabled}
        placeholder={
          disabled ? (disabledReason ?? '暂不可输入') : dragging ? '松开以添加文件' : '描述你想完成的任务，可拖入或粘贴文件；Enter 发送，Shift+Enter 换行'
        }
        className="block max-h-[220px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground"
      />
      <div className="flex items-center gap-1.5 px-2 pt-1 pb-2">
        {voice.state === 'recording' || voice.state === 'transcribing' ? (
          <div
            data-testid="voice-bar"
            className="flex h-7 min-w-0 flex-1 animate-fade-in items-center gap-2 rounded-md bg-muted px-2.5 text-xs text-muted-foreground"
          >
            {voice.state === 'recording' ? (
              <>
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
                <span>正在听</span>
                <span className="flex h-3.5 items-center gap-0.5" aria-hidden>
                  {[0.6, 1, 0.75, 0.9, 0.5].map((k, i) => (
                    <span
                      key={i}
                      className="w-0.5 rounded-full bg-brand transition-[height] duration-75"
                      style={{ height: `${Math.max(15, voice.level * k * 100)}%` }}
                    />
                  ))}
                </span>
                <span className="tabular-nums">{Math.floor(voice.elapsed / 1000)}″</span>
                <span className="ml-auto truncate text-subtle-foreground">松开或再点一次完成 · Esc 取消</span>
                <Button variant="ghost" size="icon-sm" className="size-6" aria-label="取消录音" onClick={voice.cancel}>
                  <X />
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span className="truncate">{voice.slow ? '正在识别…第一次使用本机识别时要先下载模型，可能需要几分钟' : '正在识别…'}</span>
              </>
            )}
          </div>
        ) : (
          <>
            <Tooltip content="添加文件（PDF、Word、Excel、PPT、图片、代码…）" side="top">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  void pick().then(
                    (recs) => attach(recs.map((r) => r.id)),
                    (e) => toast.error('添加文件失败', { description: errorMessage(e) }),
                  )
                }
                aria-label="添加文件"
                disabled={disabled}
              >
                <Paperclip />
              </Button>
            </Tooltip>
            {models.length ? (
              <div className="w-52">
                <Select
                  value={current?.id}
                  onChange={onModelChange}
                  className="h-7 border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent"
                  options={models.map((m) => ({ value: m.id, label: m.displayName }))}
                />
              </div>
            ) : null}
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip content={voice.state === 'recording' ? '完成录音' : '语音输入：按住说话，或点一下开始 · ⌘⇧M'} side="top">
            <Button
              variant={voice.state === 'recording' ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={voice.state === 'recording' ? '完成录音' : '语音输入'}
              aria-pressed={voice.state === 'recording'}
              disabled={disabled || voice.state === 'starting' || voice.state === 'transcribing'}
              onPointerDown={(e) => {
                // the release comes back here even if the pointer has moved off the button
                e.currentTarget.setPointerCapture(e.pointerId)
                micDown()
              }}
              onPointerUp={micUp}
              onPointerCancel={micUp}
              className={cn(voice.state === 'recording' && 'text-danger')}
            >
              {voice.state === 'recording' ? <Square className="size-3 fill-current" /> : <Mic />}
            </Button>
          </Tooltip>
          {running ? (
            <Tooltip content="停止" side="top">
              <Button variant="secondary" size="icon-sm" onClick={onStop} aria-label="停止">
                <Square className="size-3 fill-current" />
              </Button>
            </Tooltip>
          ) : (
            <Button
              variant="primary"
              size="icon-sm"
              onClick={() => submit()}
              disabled={disabled || (!text.trim() && !attached.length)}
              aria-label="发送"
              className={cn('rounded-md')}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
