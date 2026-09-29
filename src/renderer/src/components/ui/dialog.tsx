import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'
import { useOverlay } from '@/stores/overlay'

/** Controlled dialogs only: the overlay counter follows `open` (content wrappers render while closed). */
export function Dialog(props: React.ComponentProps<typeof D.Root>) {
  useOverlay(!!props.open)
  return <D.Root {...props} />
}
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

export function DialogContent({
  className,
  children,
  title,
  description,
  footer,
  ...props
}: React.ComponentProps<typeof D.Content> & { title: string; description?: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/50" />
      <D.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(560px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-popover shadow-float outline-none',
          'duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <D.Title className="text-lg font-semibold">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-sm text-muted-foreground">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          <D.Close className="interactive -mr-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </D.Content>
    </D.Portal>
  )
}
