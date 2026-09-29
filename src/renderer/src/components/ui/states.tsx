import { AlertCircle, RotateCw, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4', className)} />
}

/** Skeleton rows shaped like a list of cards/rows. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)} aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5">
          <Skeleton className="size-8 rounded-md" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex animate-fade-in flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-card">
        <Icon className="size-5 stroke-[1.5] text-muted-foreground" />
      </div>
      <p className="text-base font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function ErrorState({ error, onRetry, className, compact }: { error: string; onRetry?: () => void; className?: string; compact?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const summary = error.split('\n')[0].slice(0, 160)
  return (
    <div role="alert" className={cn('animate-fade-in rounded-lg border border-l-2 border-border border-l-danger bg-danger-soft px-4 py-3', className)}>
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-4 shrink-0 stroke-[1.75] text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{compact ? summary : '加载失败'}</p>
          {!compact ? <p className="mt-0.5 text-sm break-words text-muted-foreground">{summary}</p> : null}
          {open ? (
            <pre className="selectable mt-2 max-h-48 overflow-auto rounded-md bg-card p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {error}
            </pre>
          ) : null}
          <div className="mt-2 flex gap-3">
            {onRetry ? (
              <Button variant="link" size="sm" onClick={onRetry} className="text-xs">
                <RotateCw className="size-3" />
                重试
              </Button>
            ) : null}
            {error.length > summary.length || error.includes('\n') ? (
              <Button variant="link" size="sm" onClick={() => setOpen((v) => !v)} className="text-xs text-muted-foreground">
                {open ? '收起详情' : '查看详情'}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Renders exactly one of loading / error / empty / content. */
export function AsyncView<T>({
  state,
  loading,
  empty,
  isEmpty,
  children,
}: {
  state: { data: T | undefined; loading: boolean; error: string | null; reload: () => void }
  loading?: React.ReactNode
  empty?: React.ReactNode
  isEmpty?: (data: T) => boolean
  children: (data: T) => React.ReactNode
}) {
  if (state.error && state.data === undefined) return <ErrorState error={state.error} onRetry={state.reload} />
  if (state.data === undefined) return <>{loading ?? <ListSkeleton />}</>
  const empt = isEmpty ? isEmpty(state.data) : Array.isArray(state.data) && state.data.length === 0
  if (empt && empty) return <>{empty}</>
  return (
    <>
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} compact className="mb-3" /> : null}
      {children(state.data)}
    </>
  )
}

/** Thin top progress bar for long operations. */
export function ProgressBar({ active }: { active: boolean }) {
  return (
    <div
      className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden transition-opacity duration-200', active ? 'opacity-100' : 'opacity-0')}
    >
      <div className="h-full w-2/5 animate-progress bg-brand" />
    </div>
  )
}
