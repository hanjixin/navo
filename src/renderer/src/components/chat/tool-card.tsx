import { Check, ChevronRight, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import type { ToolCall, UIMessage } from '@shared/types'
import { cn } from '@/lib/utils'
import { argSummary, toolMeta } from './tool-meta'

export function ToolCard({ call, result, pending }: { call: ToolCall; result?: UIMessage; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const { label, icon: Icon } = toolMeta(call.name)
  const summary = argSummary(call.name, call.args)
  const status = result ? (result.status === 'error' ? 'error' : 'success') : pending ? 'running' : 'idle'

  return (
    <div className="min-w-0 rounded-md border border-border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="interactive flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs hover:bg-accent/60"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-subtle-foreground transition-transform duration-150', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 stroke-[1.75] text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {summary ? <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">{summary}</span> : null}
        <span className="ml-auto shrink-0">
          {status === 'running' ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : status === 'success' ? (
            <Check className="size-3.5 text-success" />
          ) : status === 'error' ? (
            <X className="size-3.5 text-danger" />
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="grid animate-fade-in gap-2 border-t border-border px-3 py-2.5">
          <div>
            <div className="mb-1 text-[11px] font-medium text-subtle-foreground">参数</div>
            <pre className="selectable max-h-48 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {result ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-subtle-foreground">结果</div>
              {result.images?.length ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {result.images.map((src, i) => (
                    <img key={i} src={src} className="max-h-56 rounded-sm border border-border" alt="截图" />
                  ))}
                </div>
              ) : null}
              {result.content ? (
                <pre
                  className={cn(
                    'selectable max-h-72 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap',
                    result.status === 'error' && 'text-danger',
                  )}
                >
                  {result.content}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
