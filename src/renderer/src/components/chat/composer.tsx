import { ArrowUp, Paperclip, Square } from 'lucide-react'
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

  const submit = () => {
    const t = text.trim()
    if ((!t && !attached.length) || running || disabled) return
    onSend(t, attached)
    setText('')
    setAttached([])
  }

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
        <div className="ml-auto">
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
              onClick={submit}
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
