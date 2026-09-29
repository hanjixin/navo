import { Tooltip as T } from 'radix-ui'
import * as React from 'react'

export const TooltipProvider = T.Provider

export function Tooltip({
  content,
  children,
  side = 'bottom',
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <T.Root delayDuration={400}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
