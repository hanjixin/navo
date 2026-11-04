import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** Editable model IDs with an explicit list, independent of native datalist popups. */
export function ModelIdInput({
  value,
  onChange,
  options,
  open,
  onOpenChange,
  loading,
  loaded,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  loaded: boolean
  placeholder: string
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const matches = useMemo(() => options.filter((option) => option.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [options, query])
  const selected = active >= 0 && active < matches.length ? active : -1
  useEffect(() => {
    if (open && selected >= 0) list.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [open, selected, matches])
  const showAll = () => {
    setQuery('')
    setActive(options.indexOf(value))
    onOpenChange(true)
  }
  const choose = (model: string) => {
    onChange(model)
    onOpenChange(false)
    input.current?.focus()
  }
  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false)
      }}
    >
      <Input
        ref={input}
        aria-label={t('模型 ID')}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && selected >= 0 ? `${id}-${selected}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        className="pr-9 font-mono text-xs"
        onClick={() => {
          if (!open) showAll()
        }}
        onChange={(event) => {
          onChange(event.target.value)
          setQuery(event.target.value)
          setActive(-1)
          onOpenChange(true)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) {
              setQuery('')
              setActive(event.key === 'ArrowDown' ? 0 : options.length - 1)
              onOpenChange(true)
            } else if (matches.length)
              setActive(event.key === 'ArrowDown' ? (selected + 1) % matches.length : selected <= 0 ? matches.length - 1 : selected - 1)
          } else if (event.key === 'Enter' && open && selected >= 0) {
            event.preventDefault()
            choose(matches[selected])
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            onOpenChange(false)
          } else if (event.key === 'Tab') onOpenChange(false)
        }}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-0 right-0 h-8 w-8"
        aria-label={open ? t('收起模型列表') : t('展开模型列表')}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) onOpenChange(false)
          else showAll()
          input.current?.focus()
        }}
      >
        <ChevronDown className={cn('size-3.5', open && 'rotate-180')} />
      </Button>
      {open ? (
        <div className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-float">
          <div ref={list} id={id} role="listbox" aria-label={t('可用模型')} className="max-h-56 overflow-y-auto p-1">
            {matches.map((model, index) => (
              <button
                key={model}
                id={`${id}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={value === model}
                className={cn(
                  'interactive flex min-h-8 w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-accent',
                  selected === index && 'bg-accent',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(model)}
              >
                <span className="min-w-0 flex-1 break-all">{model}</span>
                {value === model ? <Check className="size-3.5 shrink-0 text-brand" /> : null}
              </button>
            ))}
          </div>
          {!matches.length ? (
            <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
              {loading
                ? t('正在获取模型列表…')
                : query
                  ? t('没有匹配的模型，可以继续手动输入。')
                  : loaded
                    ? t('未返回可用模型，可以手动输入模型 ID。')
                    : t('请先拉取模型列表，或直接手动输入模型 ID。')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
