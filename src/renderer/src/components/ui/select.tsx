import { Select as S } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'
import { useOverlay } from '@/stores/overlay'

export interface Option {
  value: string
  label: React.ReactNode
  hint?: React.ReactNode
}

function Content({ children }: { children: React.ReactNode }) {
  return (
    <S.Portal>
      <S.Content
        position="popper"
        sideOffset={4}
        className="z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-popover shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0"
      >
        <S.Viewport className="p-1">{children}</S.Viewport>
      </S.Content>
    </S.Portal>
  )
}

export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  className,
  disabled,
}: {
  value: string | undefined
  onChange: (v: string) => void
  options: Option[]
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  // Radix keeps Select content mounted in a detached fragment while closed, so track `open` explicitly
  const [open, setOpen] = React.useState(false)
  useOverlay(open)
  return (
    <S.Root value={value} onValueChange={onChange} disabled={disabled} open={open} onOpenChange={setOpen}>
      <S.Trigger
        className={cn(
          'interactive flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-2.5 text-sm outline-none hover:border-muted-foreground/40 focus:ring-2 focus:ring-ring disabled:opacity-50 data-[placeholder]:text-subtle-foreground',
          className,
        )}
      >
        <span className="truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </S.Icon>
      </S.Trigger>
      <Content>
        {options.map((o) => (
          <S.Item
            key={o.value}
            value={o.value}
            className="interactive relative flex min-h-8 cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[highlighted]:bg-accent"
          >
            <div className="min-w-0">
              <S.ItemText>{o.label}</S.ItemText>
              {o.hint ? <div className="text-xs text-muted-foreground">{o.hint}</div> : null}
            </div>
            <S.ItemIndicator className="absolute right-2">
              <Check className="size-3.5 text-brand" />
            </S.ItemIndicator>
          </S.Item>
        ))}
      </Content>
    </S.Root>
  )
}
