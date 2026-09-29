import { Tabs as T } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

export const Tabs = T.Root
export const TabsContent = T.Content

export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn('inline-flex items-center gap-1 border-b border-border', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'interactive -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground data-[state=active]:border-brand data-[state=active]:text-foreground [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  )
}
