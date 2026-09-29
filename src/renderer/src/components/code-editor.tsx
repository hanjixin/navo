import { lazy, Suspense } from 'react'
import { cn } from '@/lib/utils'

const Impl = lazy(() => import('./code-editor-impl'))

export function CodeEditor({
  className,
  ...props
}: {
  value: string
  onChange?: (v: string) => void
  language: string
  readOnly?: boolean
  onSave?: () => void
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <Suspense fallback={<div className="skeleton h-full w-full rounded-none" />}>
        <Impl {...props} />
      </Suspense>
    </div>
  )
}
