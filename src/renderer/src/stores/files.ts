import { create } from 'zustand'
import type { FileRecord } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface FilesState {
  items: FileRecord[] | undefined
  error: string | null
  byId: Record<string, FileRecord>
  load: () => Promise<void>
  /** Adds dropped / picked / pasted files; returns the records (parsing continues in the background). */
  addFiles: (files: File[]) => Promise<FileRecord[]>
  pick: () => Promise<FileRecord[]>
}

const index = (items: FileRecord[]) => Object.fromEntries(items.map((f) => [f.id, f]))

export const useFiles = create<FilesState>((set) => {
  on('files.changed', (rec) =>
    set((s) => {
      const deleted = rec.error === '__deleted__'
      const rest = (s.items ?? []).filter((f) => f.id !== rec.id)
      const items = deleted ? rest : [rec, ...rest].sort((a, b) => b.createdAt - a.createdAt)
      const byId = { ...s.byId }
      if (deleted) delete byId[rec.id]
      else byId[rec.id] = rec
      return { items: s.items ? items : s.items, byId }
    }),
  )
  const merge = (recs: FileRecord[]) =>
    set((s) => ({ byId: { ...s.byId, ...index(recs) }, items: s.items ? [...recs, ...s.items.filter((f) => !recs.some((r) => r.id === f.id))] : s.items }))
  return {
    items: undefined,
    error: null,
    byId: {},
    load: async () => {
      try {
        const items = await call('files.list')
        set({ items, byId: index(items), error: null })
      } catch (e) {
        set({ error: errorMessage(e) })
      }
    },
    addFiles: async (list) => {
      const withPath = list.map((f) => ({ f, path: window.api.pathForFile(f) }))
      const recs: FileRecord[] = []
      const paths = withPath.filter((x) => x.path).map((x) => x.path)
      if (paths.length) recs.push(...(await call('files.addPaths', paths)))
      // pasted content (screenshots etc.) has no path on disk
      for (const { f } of withPath.filter((x) => !x.path))
        recs.push(await call('files.addData', f.name || `粘贴-${Date.now()}.png`, new Uint8Array(await f.arrayBuffer())))
      merge(recs)
      return recs
    },
    pick: async () => {
      const recs = await call('files.pick')
      merge(recs)
      return recs
    },
  }
})

/** Live record for an id (from events), falling back to what the caller has. */
export const useFileRecord = (id: string, fallback?: FileRecord) => useFiles((s) => s.byId[id] ?? fallback)

export function formatFileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function describeFile(f: Pick<FileRecord, 'units' | 'unitLabel' | 'chars' | 'ocrPages'>): string {
  const parts: string[] = []
  if (f.units && f.unitLabel) parts.push(`${f.units} ${f.unitLabel}`)
  if (f.chars) parts.push(`${f.chars.toLocaleString()} 字`)
  if (f.ocrPages?.length) parts.push(`OCR ${f.ocrPages.length} 页`)
  return parts.join(' · ')
}
