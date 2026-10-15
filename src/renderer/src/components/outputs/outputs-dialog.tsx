import { Download, ExternalLink, FileDown, FolderOpen, PackageOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ExportFormat, OutputFile, OutputPreview } from '@shared/types'
import { Markdown } from '@/components/chat/markdown'
import { FileIcon } from '@/components/files/file-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { AsyncView, EmptyState, ErrorState, ListSkeleton, Skeleton } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { formatFileSize } from '@/stores/files'
import { t } from '@shared/i18n'

const FORMAT_LABEL: Record<ExportFormat, string> = { docx: 'Word', pdf: 'PDF', xlsx: 'Excel' }
/** FileIcon's kinds */
const ICON_KIND: Record<OutputFile['kind'], string | null> = {
  markdown: 'text',
  html: 'html',
  table: 'sheet',
  json: 'data',
  image: 'image',
  pdf: 'pdf',
  document: 'word',
  text: 'text',
  other: null,
}

function PreviewBody({ p }: { p: OutputPreview }) {
  switch (p.kind) {
    case 'markdown':
      return (
        <div className="selectable px-5 py-4 text-sm">
          <Markdown text={p.text} />
          {p.truncated ? <p className="mt-3 text-xs text-subtle-foreground">{t('（文件较长，只显示了开头）')}</p> : null}
        </div>
      )
    case 'document':
    case 'pdf':
      return (
        <div className="selectable px-5 py-4 text-sm">
          <Markdown text={p.markdown} />
        </div>
      )
    case 'text':
    case 'json':
      return <pre className="selectable px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{p.text}</pre>
    case 'html':
      // the page is shown as is, without running its scripts
      return <iframe title={t('HTML 预览')} sandbox="" srcDoc={p.html} className="size-full min-h-[50vh] bg-white" />
    case 'image':
      return (
        <div className="flex justify-center p-4">
          <img src={p.dataUrl} alt="" className="max-h-[60vh] max-w-full rounded-md border border-border object-contain" />
        </div>
      )
    case 'table':
      return (
        <div className="selectable overflow-auto">
          <table className="w-max min-w-full border-collapse text-xs" data-testid="output-table">
            <tbody>
              {p.rows.map((r, i) => (
                <tr key={i} className={cn(i === 0 && 'sticky top-0 bg-muted font-medium')}>
                  {r.map((c, j) => (
                    <td key={j} className="max-w-64 truncate border border-border px-2 py-1" title={c}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {p.truncated || p.sheets ? (
            <p className="px-3 py-2 text-xs text-subtle-foreground">
              {p.truncated ? t('只显示了前 300 行。') : ''}
              {p.sheets ? t('共 {{v0}} 个工作表，这里显示第一个（{{v1}}）。', { v0: p.sheets.length, v1: p.sheets[0] }) : ''}
            </p>
          ) : null}
        </div>
      )
    default:
      return <EmptyState icon={PackageOpen} title={t('无法预览')} description={p.message} />
  }
}

function Preview({ file }: { file: OutputFile }) {
  const preview = useAsync(() => call('outputs.preview', file.id), [file.id, file.at])
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (key: string, fn: () => Promise<string | null | void>, done?: (r: string) => string) => {
    setBusy(key)
    try {
      const r = await fn()
      if (typeof r === 'string' && done) toast.success(done(r), { action: { label: t('在访达中显示'), onClick: () => void call('app.showItemInFolder', r) } })
    } catch (e) {
      toast.error(t('操作失败'), { description: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
        <div className="mr-auto min-w-0">
          <div className="truncate text-sm font-medium" title={file.path}>
            {file.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {file.source === 'download' ? t('下载的文件') : file.path} · {formatFileSize(file.size)}
          </div>
        </div>
        {file.exports.map((f) => (
          <Button
            key={f}
            variant="secondary"
            size="sm"
            loading={busy === f}
            onClick={() =>
              void act(
                f,
                () => call('outputs.export', file.id, f),
                (p) => t('已导出 {{v0}}：{{v1}}', { v0: FORMAT_LABEL[f], v1: p.split('/').pop() }),
              )
            }
          >
            {busy !== f ? <FileDown /> : null}
            {t('导出 {{v0}}', { v0: FORMAT_LABEL[f] })}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          disabled={file.missing}
          loading={busy === 'save'}
          onClick={() =>
            void act(
              'save',
              () => call('outputs.saveAs', file.id),
              () => t('已另存'),
            )
          }
        >
          {busy !== 'save' ? <Download /> : null}
          {t('另存为')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('在访达中显示')}
          title={t('在访达中显示')}
          disabled={file.missing}
          onClick={() => void call('outputs.reveal', file.id)}
        >
          <FolderOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('用默认应用打开')}
          title={t('用默认应用打开')}
          disabled={file.missing}
          onClick={() => void act('open', () => call('outputs.open', file.id))}
        >
          <ExternalLink />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="output-preview">
        {preview.error ? (
          <ErrorState error={preview.error} onRetry={preview.reload} className="m-4" />
        ) : !preview.data ? (
          <div className="grid gap-2 p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <PreviewBody p={preview.data} />
        )}
      </div>
    </div>
  )
}

/** What a conversation produced: preview, export to Word / PDF / Excel, save, reveal. */
export function OutputsDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const list = useAsync(() => call('outputs.list', threadId), [threadId])
  const [selected, setSelected] = useState<string | null>(null)
  const current = list.data?.find((f) => f.id === selected) ?? list.data?.[0]

  useEffect(
    () =>
      on('outputs.changed', (e) => {
        if (e.threadId === threadId) list.reload()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId],
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('产出')}
        description={t('这个对话里 Agent 写下或下载的文件')}
        className="h-[min(720px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))]"
      >
        <AsyncView
          state={list}
          loading={<ListSkeleton rows={3} />}
          empty={
            <EmptyState icon={PackageOpen} title={t('还没有产出')} description={t('Agent 在 /workspace/ 写下的文件和在浏览器里下载的文件会出现在这里。')} />
          }
        >
          {(files) => (
            <div className="-mx-5 -my-4 flex h-full min-h-0 flex-col sm:flex-row">
              <ul
                className="max-h-40 shrink-0 overflow-y-auto border-b border-border p-2 sm:max-h-none sm:w-60 sm:border-r sm:border-b-0"
                data-testid="output-list"
              >
                {files.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => setSelected(f.id)}
                      className={cn(
                        'interactive flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                        current?.id === f.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <FileIcon kind={ICON_KIND[f.kind]} ext={f.name.split('.').pop()} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-sm', f.missing && 'line-through')}>{f.name}</span>
                        <span className="block truncate text-[11px] text-subtle-foreground">
                          {f.source === 'download' ? t('下载 · ') : ''}
                          {timeAgo(f.at)}
                        </span>
                      </span>
                      {f.missing ? <Badge variant="warning">{t('已移除')}</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {current ? <Preview key={current.id} file={current} /> : null}
            </div>
          )}
        </AsyncView>
      </DialogContent>
    </Dialog>
  )
}
