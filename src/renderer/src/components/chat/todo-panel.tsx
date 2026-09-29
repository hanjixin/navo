import { Check, ChevronDown, Circle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import type { Todo } from '@shared/types'
import { cn } from '@/lib/utils'

export function TodoPanel({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true)
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  return (
    <div className="animate-fade-in rounded-lg border border-border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="interactive flex h-9 w-full items-center gap-2.5 px-3 text-left text-xs hover:bg-accent/50">
        <span className="font-medium">任务计划</span>
        <span className="text-muted-foreground">
          {done}/{todos.length}
        </span>
        <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-brand transition-[width] duration-300" style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
        {!open && current ? <span className="min-w-0 truncate text-muted-foreground">{current.content}</span> : null}
        <ChevronDown className={cn('ml-auto size-3.5 text-subtle-foreground transition-transform duration-150', !open && '-rotate-90')} />
      </button>
      {open ? (
        <ul className="grid gap-1 border-t border-border px-3 py-2">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-5">
              {t.status === 'completed' ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : t.status === 'in_progress' ? (
                <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-brand" />
              ) : (
                <Circle className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
              )}
              <span
                className={cn(t.status === 'completed' && 'text-muted-foreground line-through decoration-border', t.status === 'in_progress' && 'font-medium')}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
