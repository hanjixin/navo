import { DropdownMenu as M } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'
import { useOverlay } from '@/stores/overlay'

/**
 * The overlay counter must follow the open state, not mounting: content wrappers render (and would
 * register) even while the menu is closed.
 */
export function DropdownMenu({ open: openProp, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof M.Root>) {
  const [inner, setInner] = React.useState(defaultOpen ?? false)
  const open = openProp ?? inner
  useOverlay(open)
  return (
    <M.Root
      {...props}
      open={open}
      onOpenChange={(o) => {
        setInner(o)
        onOpenChange?.(o)
      }}
    />
  )
}
export const DropdownMenuTrigger = M.Trigger

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-float',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]',
          className,
        )}
        {...props}
      />
    </M.Portal>
  )
}

export function DropdownMenuItem({ className, danger, ...props }: React.ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return (
    <M.Item
      className={cn(
        'interactive flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:stroke-[1.75] [&_svg]:text-muted-foreground',
        danger && 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof M.Label>) {
  return <M.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />
}

export function DropdownMenuSeparator() {
  return <M.Separator className="-mx-1 my-1 h-px bg-border" />
}
