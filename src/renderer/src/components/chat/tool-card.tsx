import { Check, ChevronRight, Clock3, Loader2, Minus, X } from 'lucide-react'
import { useId, useState } from 'react'
import type { ToolCall, UIMessage } from '@shared/types'
import { cn } from '@/lib/utils'
import { toolPresentation, toolScopeLabel } from './tool-meta'
import { toolDisplayStatus, type ToolDisplayStatus } from './message-groups'
import { RuntimeWarning } from './runtime-warning'
import { t } from '@shared/i18n'

const statusLabel = (status: ToolDisplayStatus) => {
  if (status === 'pending') return t('等待确认')
  if (status === 'running') return t('执行中')
  if (status === 'success') return t('已完成')
  if (status === 'error') return t('执行失败')
  if (status === 'cancelled') return t('已取消')
  return t('未完成')
}

export function ToolCard({ call, result, pending, compact = false }: { call: ToolCall; result?: UIMessage; pending: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const { label, icon: Icon, summary, command, cwd, paths } = toolPresentation(call)
  const status = toolDisplayStatus(call, result, pending)
  const stateText = statusLabel(status)
  const scopeText = toolScopeLabel(call.name)

  return (
    <div className={cn('min-w-0 rounded-md', compact ? 'bg-transparent' : 'border border-border bg-card', status === 'error' && 'bg-danger/5')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${label}${summary ? ` · ${summary}` : ''} · ${stateText}`}
        className={cn(
          'interactive flex w-full items-center gap-2 rounded-md px-2.5 text-left text-xs hover:bg-accent/60',
          compact ? 'min-h-7 py-1' : 'min-h-8 py-1.5',
        )}
      >
        <ChevronRight aria-hidden="true" className={cn('size-3 shrink-0 text-subtle-foreground transition-transform duration-150', open && 'rotate-90')} />
        <Icon aria-hidden="true" className="size-3.5 shrink-0 stroke-[1.75] text-muted-foreground" />
        <span className="max-w-[45%] min-w-0 shrink-0 truncate font-medium text-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 rounded border border-border/70 px-1 py-0.5 text-[10px] text-subtle-foreground" title={scopeText}>
          {scopeText}
        </span>
        {summary ? (
          <span title={summary} className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
            {summary}
          </span>
        ) : null}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px]" title={stateText}>
          {status === 'running' ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
          ) : status === 'success' ? (
            <Check aria-hidden="true" className="size-3.5 text-success" />
          ) : status === 'error' ? (
            <>
              <X aria-hidden="true" className="size-3.5 text-danger" />
              <span className="text-danger">{stateText}</span>
            </>
          ) : status === 'pending' ? (
            <>
              <Clock3 aria-hidden="true" className="size-3.5 text-warning" />
              <span className="text-warning">{stateText}</span>
            </>
          ) : (
            <Minus aria-hidden="true" className="size-3.5 text-muted-foreground" />
          )}
        </span>
      </button>
      {result?.runtimeWarning ? (
        <div className="mx-2 mb-1.5">
          <RuntimeWarning warning={result.runtimeWarning} />
        </div>
      ) : null}
      {open ? (
        <div id={detailsId} className="grid animate-fade-in gap-2 border-t border-border/60 px-3 py-2.5">
          {command ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-subtle-foreground">{t('命令')}</div>
              <pre className="selectable max-h-48 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                {command}
              </pre>
              {cwd ? (
                <p className="mt-1.5 font-mono text-[11px] break-all text-muted-foreground">
                  <span className="font-sans">{t('工作目录')}：</span>
                  {cwd}
                </p>
              ) : null}
            </div>
          ) : paths?.length ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-subtle-foreground">{t('文件路径')}</div>
              <pre className="selectable max-h-48 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                {paths.join('\n')}
              </pre>
            </div>
          ) : (
            <div>
              <div className="mb-1 text-[11px] font-medium text-subtle-foreground">{t('参数')}</div>
              <pre className="selectable max-h-48 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </div>
          )}
          {result ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-subtle-foreground">{t('结果')}</div>
              {result.images?.length ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {result.images.map((src, i) => (
                    <img key={i} src={src} className="max-h-56 rounded-sm border border-border" alt={t('截图')} />
                  ))}
                </div>
              ) : null}
              {result.content ? (
                <pre
                  className={cn(
                    'selectable max-h-72 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap',
                    status === 'error' && 'text-danger',
                  )}
                >
                  {result.content}
                </pre>
              ) : null}
            </div>
          ) : null}
          <div className={cn('text-[11px]', status === 'error' ? 'text-danger' : status === 'pending' ? 'text-warning' : 'text-subtle-foreground')}>
            {stateText}
          </div>
        </div>
      ) : null}
    </div>
  )
}
