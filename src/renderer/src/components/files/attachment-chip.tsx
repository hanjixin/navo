import { AlertCircle, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import type { MessageAttachment } from '@shared/types'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { describeFile, useFileRecord } from '@/stores/files'
import { FileIcon } from './file-icon'
import { FilePreview } from './file-preview'

/** A file attached to a draft or a sent message: live parse status, click to preview. */
export function AttachmentChip({ id, fallback, onRemove, className }: { id: string; fallback?: MessageAttachment; onRemove?: () => void; className?: string }) {
  const live = useFileRecord(id)
  const fetched = useAsync(() => (live ? Promise.resolve(live) : call('files.get', id)), [id])
  const f = live ?? fetched.data
  const [open, setOpen] = useState(false)
  const ready = f?.status === 'ready'
  // pictures and scanned PDFs get a real thumbnail (it is also what a vision model sees)
  const thumb = useAsync(
    () => (ready && (f.kind === 'image' || f.kind === 'pdf') ? call('files.thumbnail', id) : Promise.resolve(null)),
    [id, ready, f?.parsedAt],
  )
  const name = f?.name ?? fallback?.name ?? '文件'
  const busy = f?.status === 'queued' || f?.status === 'parsing'
  const failed = f?.status === 'error'
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => f && setOpen(true)}
        onKeyDown={(e) => e.key === 'Enter' && f && setOpen(true)}
        className={cn(
          'interactive group flex h-11 max-w-60 min-w-0 cursor-pointer items-center gap-2 rounded-md border bg-card py-1.5 pr-2 pl-2.5 text-left hover:border-input',
          failed ? 'border-danger/40' : 'border-border',
          className,
        )}
        title={name}
      >
        {thumb.data ? (
          <img src={thumb.data} alt="" className="size-8 shrink-0 rounded-sm border border-border object-cover" />
        ) : (
          <FileIcon kind={f?.kind ?? fallback?.kind} ext={f?.ext} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{name}</div>
          <div className={cn('flex items-center gap-1 truncate text-[11px]', failed ? 'text-danger' : 'text-muted-foreground')}>
            {busy ? <Loader2 className="size-3 shrink-0 animate-spin text-brand" /> : failed ? <AlertCircle className="size-3 shrink-0" /> : null}
            <span className="truncate">
              {busy
                ? (f?.progress ?? '解析中…')
                : failed
                  ? '解析失败'
                  : f
                    ? describeFile(f) || '已解析'
                    : fallback?.chars
                      ? `${fallback.chars.toLocaleString()} 字`
                      : ''}
            </span>
          </div>
        </div>
        {onRemove ? (
          <button
            className="interactive -mr-0.5 rounded-sm p-0.5 text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            aria-label={`移除 ${name}`}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent title="文件内容" description="这是发送给 Agent 的解析结果" className="h-[80vh] w-[min(820px,calc(100vw-48px))]">
            {f ? <FilePreview file={f} compact /> : <Skeleton className="h-64" />}
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  )
}
