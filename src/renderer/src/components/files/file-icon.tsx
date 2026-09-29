import { Archive, BookOpen, Braces, File, FileCode2, FileImage, FileSpreadsheet, FileText, Globe, Presentation, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const ICONS: Record<string, LucideIcon> = {
  pdf: FileText,
  word: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  ebook: BookOpen,
  html: Globe,
  text: FileText,
  code: FileCode2,
  data: Braces,
  image: FileImage,
  archive: Archive,
}

const TINT: Record<string, string> = {
  pdf: 'text-danger',
  word: 'text-brand',
  sheet: 'text-success',
  slides: 'text-warning',
}

/** Icon by parsed kind, falling back to the extension while parsing hasn't finished yet. */
export function FileIcon({ kind, ext, className }: { kind?: string | null; ext?: string; className?: string }) {
  const k =
    kind ??
    (ext === 'pdf'
      ? 'pdf'
      : ['doc', 'docx', 'odt', 'rtf'].includes(ext ?? '')
        ? 'word'
        : ['xls', 'xlsx', 'csv', 'ods'].includes(ext ?? '')
          ? 'sheet'
          : ['ppt', 'pptx', 'odp'].includes(ext ?? '')
            ? 'slides'
            : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext ?? '')
              ? 'image'
              : undefined)
  const Icon = (k && ICONS[k]) || File
  return <Icon className={cn('size-4 shrink-0 stroke-[1.75]', (k && TINT[k]) || 'text-muted-foreground', className)} />
}
