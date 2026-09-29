import * as React from 'react'
import { cn } from '@/lib/utils'

export function Card({ className, interactive, ...props }: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return <div className={cn('rounded-lg border border-border bg-card', interactive && 'card-hover cursor-pointer', className)} {...props} />
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div className={cn('shrink-0 bg-border', vertical ? 'w-px self-stretch' : 'h-px w-full', className)} />
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-sm border border-border bg-muted px-1 font-mono text-[11px] text-muted-foreground">{children}</kbd>
}
