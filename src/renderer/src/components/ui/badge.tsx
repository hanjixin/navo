import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-xs font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    variant: {
      neutral: 'bg-muted text-muted-foreground',
      primary: 'bg-info-soft text-brand',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning',
      danger: 'bg-danger-soft text-danger',
      outline: 'border border-border text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export function StatusDot({ status, className }: { status: 'success' | 'warning' | 'danger' | 'neutral' | 'running'; className?: string }) {
  const color = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    neutral: 'bg-subtle-foreground',
    running: 'bg-brand animate-pulse',
  }[status]
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', color, className)} />
}
