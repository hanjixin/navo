import * as React from 'react'
import { CircleHelp, MoreHorizontal, Search, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="@container h-full overflow-y-auto">
      <div className={cn('mx-auto w-full px-4 pt-3 pb-10 @3xl:px-6', wide ? 'max-w-6xl' : 'max-w-4xl', className)}>{children}</div>
    </div>
  )
}

interface PageHeaderProps {
  title: string
  count?: number
  description?: React.ReactNode
  actions?: React.ReactNode
  more?: { label: string; icon: LucideIcon; run: () => void; disabled?: boolean }[]
  search?: { label: string; value: string; onChange: (value: string) => void }
}

export function PageHeader({ title, count, description, actions, more, search }: PageHeaderProps) {
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const id = React.useId()
  const searchTrigger = React.useRef<HTMLButtonElement>(null)
  const closeSearch = () => {
    search?.onChange('')
    setSearchOpen(false)
    searchTrigger.current?.focus()
  }
  return (
    <header className="mb-3 shrink-0 border-b border-border pb-2">
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          {count != null ? <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{count}</span> : null}
          {description ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('页面说明')}
              title={t('页面说明')}
              aria-expanded={helpOpen}
              aria-controls={`${id}-help`}
              onClick={() => setHelpOpen(!helpOpen)}
            >
              <CircleHelp />
            </Button>
          ) : null}
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
          {search ? (
            <Button
              variant="ghost"
              size="icon-sm"
              ref={searchTrigger}
              aria-label={search.label}
              title={search.label}
              aria-expanded={searchOpen}
              aria-controls={`${id}-search`}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              <Search />
            </Button>
          ) : null}
          {actions}
          {more?.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('更多操作')} title={t('更多操作')}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {more.map(({ label, icon: Icon, disabled, run }) => (
                  <DropdownMenuItem key={label} disabled={disabled} onSelect={run}>
                    <Icon />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {description ? (
        <div id={`${id}-help`} hidden={!helpOpen} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </div>
      ) : null}
      {search && searchOpen ? (
        <Input
          autoFocus
          id={`${id}-search`}
          type="search"
          className="mt-2 h-8"
          aria-label={search.label}
          placeholder={search.label}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              closeSearch()
            }
          }}
        />
      ) : null}
    </header>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('mb-6', className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}
