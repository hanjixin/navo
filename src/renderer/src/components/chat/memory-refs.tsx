import { Brain } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { MemoryRef } from '@shared/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { KIND_LABEL } from '@/stores/memory'
import { t } from '@shared/i18n'

/** Under a user message: which memories the reply could draw on; each opens on the Memory page. */
export function MemoryRefs({ refs }: { refs: MemoryRef[] }) {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="interactive flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-subtle-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          aria-label={t('引用了 {{v0}} 条记忆', { v0: refs.length })}
        >
          <Brain className="size-3" />
          {t('引用了 {{v0}} 条记忆', { v0: refs.length })}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('回答时用到的记忆')}</DropdownMenuLabel>
        {refs.map((r) => (
          <DropdownMenuItem key={r.id} onSelect={() => navigate(`/memory?focus=${r.id}`)} className="h-auto items-start py-1.5">
            <div className="min-w-0">
              <div className="truncate text-sm">{r.title}</div>
              <div className="text-xs text-muted-foreground">{KIND_LABEL[r.kind]}</div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
