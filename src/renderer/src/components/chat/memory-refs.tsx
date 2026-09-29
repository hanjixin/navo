import { Brain } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { MemoryRef } from '@shared/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { KIND_LABEL } from '@/stores/memory'

/** Under a user message: which memories the reply could draw on; each opens on the Memory page. */
export function MemoryRefs({ refs }: { refs: MemoryRef[] }) {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="interactive flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-subtle-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          aria-label={`引用了 ${refs.length} 条记忆`}
        >
          <Brain className="size-3" />
          引用了 {refs.length} 条记忆
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>回答时用到的记忆</DropdownMenuLabel>
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
