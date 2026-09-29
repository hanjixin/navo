import { Check, Cpu, FileUp, Loader2, MessageSquarePlus, Upload } from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { FileEngine, FileRecord } from '@shared/types'
import { FileIcon } from '@/components/files/file-icon'
import { FilePreview } from '@/components/files/file-preview'
import { PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { describeFile, formatFileSize, useFiles } from '@/stores/files'
import { useSettings } from '@/stores/settings'

const SUPPORTED = 'PDF（含扫描件 OCR）、Word、Excel / CSV、PowerPoint、OpenDocument、EPUB、HTML、Markdown / 文本、代码、JSON / YAML、图片、ZIP'

function EnginesDialog({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings()
  const cfg = settings!.files
  const engines = useAsync(() => call('files.engines'))
  const [token, setToken] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="解析引擎"
        description="默认使用内置引擎（离线、文件不离开本机）。复杂 PDF（多栏、公式、复杂表格）可以换用高质量引擎重新解析。"
        className="w-[600px]"
        footer={
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        }
      >
        {engines.error ? (
          <ErrorState error={engines.error} onRetry={engines.reload} />
        ) : !engines.data ? (
          <ListSkeleton rows={4} />
        ) : (
          <div className="grid gap-2">
            {engines.data.map((e) => {
              const selected = cfg.defaultEngine === e.id
              return (
                <button
                  key={e.id}
                  disabled={!e.available}
                  onClick={() => void update({ files: { ...cfg, defaultEngine: e.id as FileEngine } })}
                  className={cn(
                    'interactive flex items-start gap-3 rounded-lg border px-4 py-3 text-left',
                    selected ? 'border-primary/50 bg-info-soft' : 'border-border hover:bg-accent/40',
                    !e.available && 'cursor-not-allowed opacity-70',
                  )}
                >
                  <Cpu className="mt-0.5 size-4 shrink-0 stroke-[1.75] text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {e.name}
                      <Badge variant={e.local ? 'outline' : 'warning'}>{e.local ? '本机' : '云端'}</Badge>
                      {!e.available ? <Badge variant="neutral">未就绪</Badge> : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{e.description}</div>
                    {e.hint ? <div className="mt-1 text-xs text-subtle-foreground">{e.hint}</div> : null}
                  </div>
                  {selected ? <Check className="mt-0.5 size-4 text-brand" /> : null}
                </button>
              )
            })}
            <div className="mt-2 grid gap-3 rounded-lg border border-border p-4">
              <Field label="MinerU API Token" hint="在 mineru.net 申请。使用 MinerU 时文件会上传到其服务器。">
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={cfg.mineruTokenSet ? '已保存' : '粘贴 Token'}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="secondary"
                    disabled={!token}
                    onClick={async () => {
                      await update({ mineruToken: token })
                      setToken('')
                      engines.reload()
                      toast.success('已保存 MinerU Token')
                    }}
                  >
                    保存
                  </Button>
                </div>
              </Field>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  扫描件与图片 OCR
                  <span className="block text-xs text-muted-foreground">内置引擎识别没有文字层的 PDF 页面和图片（中英文，语言包已内置，离线可用）</span>
                </span>
                <Switch checked={cfg.ocr} onCheckedChange={(v) => void update({ files: { ...cfg, ocr: v } })} />
              </label>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function StatusLine({ f }: { f: FileRecord }) {
  if (f.status === 'queued' || f.status === 'parsing')
    return (
      <span className="flex items-center gap-1 text-xs text-brand">
        <Loader2 className="size-3 animate-spin" />
        <span className="truncate">{f.progress ?? '排队中…'}</span>
      </span>
    )
  if (f.status === 'error') return <span className="truncate text-xs text-danger">{f.error}</span>
  return <span className="truncate text-xs text-muted-foreground">{describeFile(f) || formatFileSize(f.size)}</span>
}

export function FilesPage() {
  const { items, error, load, addFiles, pick } = useFiles()
  const [selected, setSelected] = useState<string | null>(null)
  const [enginesOpen, setEnginesOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [q, setQ] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!selected && items?.length) setSelected(items[0].id)
  }, [items, selected])

  const filtered = useMemo(() => (items ?? []).filter((f) => f.name.toLowerCase().includes(q.toLowerCase())), [items, q])
  const current = items?.find((f) => f.id === selected)

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const list = Array.from(e.dataTransfer.files)
    if (!list.length) return
    try {
      const recs = await addFiles(list)
      if (recs[0]) setSelected(recs[0].id)
    } catch (err) {
      toast.error('上传失败', { description: errorMessage(err) })
    }
  }

  const startChatWith = async (f: FileRecord) => {
    const chat = useChat.getState()
    await chat.newThread()
    chat.setDraftFiles([f.id])
    navigate('/chat')
  }

  return (
    <div
      className="@container relative flex h-full flex-col px-6 pt-6 pb-6 @4xl:px-8"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <PageHeader
        title="文件"
        description="上传的文件会被解析为保留结构的 Markdown（标题、列表、表格、页码），供 Agent 阅读和引用。"
        actions={
          <>
            <Button variant="secondary" onClick={() => setEnginesOpen(true)}>
              <Cpu />
              解析引擎
            </Button>
            <Button variant="primary" onClick={() => void pick().then((r) => r[0] && setSelected(r[0].id))}>
              <Upload />
              上传文件
            </Button>
          </>
        }
      />

      {error && !items ? (
        <ErrorState error={error} onRetry={load} />
      ) : !items ? (
        <ListSkeleton rows={4} />
      ) : !items.length ? (
        <button onClick={() => void pick()} className="card-hover flex-1 rounded-lg border border-dashed border-border bg-card">
          <EmptyState icon={FileUp} title="拖入文件，或点击上传" description={`支持 ${SUPPORTED}`} />
        </button>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex w-60 shrink-0 flex-col @4xl:w-72">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件" className="mb-3 h-7 text-xs" />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid gap-1">
                {filtered.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setSelected(f.id)}
                    className={cn(
                      'interactive flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left',
                      selected === f.id ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    <FileIcon kind={f.kind} ext={f.ext} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{f.name}</div>
                      <StatusLine f={f} />
                    </div>
                    <span className="shrink-0 text-[11px] text-subtle-foreground">{timeAgo(f.createdAt)}</span>
                  </button>
                ))}
                {!filtered.length ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的文件</p> : null}
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-card p-4">
            {current ? (
              <>
                <FilePreview file={current} onDeleted={() => setSelected(null)} />
                {current.status === 'ready' ? (
                  <div className="mt-3 flex justify-end border-t border-border pt-3">
                    <Button variant="secondary" size="sm" onClick={() => void startChatWith(current)}>
                      <MessageSquarePlus />
                      在新对话中使用
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}

      {dragging ? (
        <div className="pointer-events-none absolute inset-3 flex animate-fade-in items-center justify-center rounded-lg border-2 border-dashed border-primary bg-info-soft/80 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 text-sm font-medium text-brand">
            <FileUp className="size-5" />
            松开即可上传
          </div>
        </div>
      ) : null}
      {enginesOpen ? <EnginesDialog onClose={() => setEnginesOpen(false)} /> : null}
    </div>
  )
}
