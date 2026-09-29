import { Switch as S } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'interactive inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <S.Thumb className="pointer-events-none block size-3.5 translate-x-px rounded-full bg-white shadow-sm transition-transform duration-150 ease-[var(--ease)] data-[state=checked]:translate-x-[15px]" />
    </S.Root>
  )
}
