import { Checkbox as C } from 'radix-ui'
import { Check } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'

export function Checkbox({ className, ...props }: React.ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'interactive flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <C.Indicator>
        <Check className="size-3" />
      </C.Indicator>
    </C.Root>
  )
}
