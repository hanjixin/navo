import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'interactive h-8 w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none placeholder:text-subtle-foreground hover:border-muted-foreground/40 focus:border-primary/60 focus:ring-2 focus:ring-ring disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'interactive w-full rounded-md border border-input bg-card px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-subtle-foreground hover:border-muted-foreground/40 focus:border-primary/60 focus:ring-2 focus:ring-ring disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string
  hint?: React.ReactNode
  error?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
