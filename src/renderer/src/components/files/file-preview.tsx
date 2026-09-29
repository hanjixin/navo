import { AlertTriangle, FolderOpen, Loader2, RotateCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { FileEngine, FileRecord } from '@shared/types'
import { Markdown } from '@/components/chat/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { errorMessage, timeAgo } from '@/lib/utils'
import { describeFile, formatFileSize, useFileRecord } from '@/stores/files'
import { FileIcon } from './file-icon'

const ENGINE_LABEL: Record<FileEngine, string> = { builtin: '内置引擎', markitdown: 'MarkItDown', docling: 'Docling', mineru: 'MinerU 云端' }

/** Rendered / raw Markdown plus parse details; used on the Files page and from chat attachments. */
export function FilePreview({ file: initial, onDeleted, compact }: { file: FileRecord; onDeleted?: () => void; compact?: boolean }) {
  const file = useFileRecord(initial.id, initial)!
  const [md, setMd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const engines = useAsync(() => call('files.engines'), [])
  const picture = useAsync(
    () => (file.kind === 'image' && file.status === 'ready' ? call('files.image', file.id) : Promise.resolve(null)),
    [file.id, file.status, file.parsedAt],
  )

  useEffect(() => {
    setMd(null)
    setError(null)
    if (file.status === 'ready') call('files.markdown', file.id).then(setMd, (e) => setError(errorMessage(e)))
  }, [file.id, file.status, file.parsedAt])

  const reparse = async (engine: FileEngine) => {
    try {
      await call('files.reparse', file.id, engine)
    } catch (e) {
      toast.error('重新解析失败', { description: errorMessage(e) })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card">
          <FileIcon kind={file.kind} ext={file.ext} className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatFileSize(file.size)}
            {file.status === 'ready' ? ` · ${describeFile(file)}` : ''}
            {file.engine ? ` · ${ENGINE_LABEL[file.engine]}` : ''}
          </div>
        </div>
        {!compact || file.status !== 'parsing' ? (
          <div className="flex gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" disabled={file.status === 'parsing' || file.status === 'queued'}>
                  <RotateCw />
                  重新解析
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>选择解析引擎</DropdownMenuLabel>
                {(engines.data ?? []).map((e) => (
                  <DropdownMenuItem key={e.id} disabled={!e.available} onSelect={() => void reparse(e.id)} className="h-auto items-start py-1.5">
                    <div>
                      <div className="text-sm">{e.name}</div>
                      <div className="text-xs text-muted-foreground">{e.available ? (e.local ? '本机处理' : '文件会上传') : e.hint}</div>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon-sm" onClick={() => void call('files.reveal', file.id)} aria-label="在访达中显示">
              <FolderOpen />
            </Button>
            {onDeleted ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="hover:text-danger"
                aria-label="删除"
                onClick={async () => {
                  await call('files.delete', file.id)
                  onDeleted()
                }}
              >
                <Trash2 />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {file.warnings.length && file.status === 'ready' ? (
        <div className="mb-3 flex items-start gap-2 rounded-md border-l-2 border-l-warning bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <div>{file.warnings.join('；')}</div>
        </div>
      ) : null}

      {file.status === 'queued' || file.status === 'parsing' ? (
        <div className="grid gap-3 rounded-lg border border-border bg-card p-4" aria-busy="true">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin text-brand" />
            {file.progress ?? (file.status === 'queued' ? '排队中…' : '正在解析…')}
          </div>
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : file.status === 'error' ? (
        <ErrorState error={file.error ?? '解析失败'} onRetry={() => void reparse(file.engine ?? 'builtin')} />
      ) : error ? (
        <ErrorState error={error} />
      ) : md == null ? (
        <Skeleton className="h-64" />
      ) : (
        <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="w-full">
            <TabsTrigger value="preview">预览</TabsTrigger>
            <TabsTrigger value="source">Markdown</TabsTrigger>
            <TabsTrigger value="info">信息</TabsTrigger>
          </TabsList>
          <TabsContent value="preview" className="min-h-0 flex-1 overflow-y-auto pt-4">
            {picture.data ? (
              <figure className="mb-4">
                <img src={picture.data} alt={file.name} className="max-h-[50vh] rounded-md border border-border" />
                <figcaption className="mt-2 text-xs text-muted-foreground">
                  支持看图的模型会直接收到这张图片；下面是 OCR 识别的文字，供不支持看图的模型使用。
                </figcaption>
              </figure>
            ) : null}
            <Markdown text={md.replace(/<!-- (第 \d+ 页) -->/g, '\n\n*— $1 —*\n\n')} className="selectable" />
          </TabsContent>
          <TabsContent value="source" className="min-h-0 flex-1 pt-4">
            <pre className="selectable h-full overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
              {md}
            </pre>
          </TabsContent>
          <TabsContent value="info" className="pt-4">
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">类型</dt>
              <dd>{file.kind ?? file.ext}</dd>
              <dt className="text-muted-foreground">大小</dt>
              <dd>{formatFileSize(file.size)}</dd>
              <dt className="text-muted-foreground">内容</dt>
              <dd>{describeFile(file) || '—'}</dd>
              <dt className="text-muted-foreground">引擎</dt>
              <dd>{file.engine ? ENGINE_LABEL[file.engine] : '—'}</dd>
              <dt className="text-muted-foreground">Agent 路径</dt>
              <dd>
                <code className="font-mono text-xs break-all">{file.agentPath}</code>
              </dd>
              <dt className="text-muted-foreground">上传</dt>
              <dd>{timeAgo(file.createdAt)}</dd>
              {file.ocrPages.length ? (
                <>
                  <dt className="text-muted-foreground">OCR 页</dt>
                  <dd>
                    {file.ocrPages.map((p) => (
                      <Badge key={p} variant="outline" className="mr-1">
                        {p}
                      </Badge>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
