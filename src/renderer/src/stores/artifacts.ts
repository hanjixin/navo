import { create } from 'zustand'
import type { ArtifactsQuery } from '@shared/files-query'
import type { Artifact } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

export type ArtifactScope = Omit<ArtifactsQuery, 'cursor'>
export interface ArtifactQuery {
  items?: Artifact[]
  nextCursor?: string | null
  loading: boolean
  error: string | null
}
export const artifactScopeKey = (scope: ArtifactScope): string =>
  JSON.stringify([scope.projectId ?? null, scope.projectId === undefined, scope.threadId ?? null, scope.q?.trim() ?? '', scope.kind ?? null, scope.limit ?? 50])

interface ArtifactState {
  queries: Record<string, ArtifactQuery>
  load: (scope?: ArtifactScope, more?: boolean) => Promise<void>
  watch: (scope: ArtifactScope) => () => void
  refresh: () => void
}

export const useArtifacts = create<ArtifactState>((set, get) => {
  const versions = new Map<string, number>()
  const watched = new Map<string, { scope: ArtifactScope; count: number }>()
  return {
    queries: {},
    load: async (scope = {}, more = false) => {
      const key = artifactScopeKey(scope)
      const previous = get().queries[key]
      if (more && (previous?.loading || !previous?.nextCursor)) return
      const version = (versions.get(key) ?? 0) + 1
      versions.set(key, version)
      set((s) => ({ queries: { ...s.queries, [key]: { items: s.queries[key]?.items, loading: true, error: null } } }))
      try {
        const page = await call('artifacts.query', { ...scope, cursor: more ? (previous?.nextCursor ?? undefined) : undefined })
        if (versions.get(key) !== version) return
        const items = more ? [...new Map([...(previous?.items ?? []), ...page.items].map((item) => [item.id, item])).values()] : page.items
        set((s) => ({ queries: { ...s.queries, [key]: { items, nextCursor: page.nextCursor, loading: false, error: null } } }))
      } catch (e) {
        if (versions.get(key) !== version) return
        set((s) => ({ queries: { ...s.queries, [key]: { items: undefined, loading: false, error: errorMessage(e) } } }))
      }
    },
    watch: (scope) => {
      const key = artifactScopeKey(scope)
      watched.set(key, { scope, count: (watched.get(key)?.count ?? 0) + 1 })
      return () => {
        const current = watched.get(key)
        if (!current || current.count <= 1) watched.delete(key)
        else watched.set(key, { ...current, count: current.count - 1 })
      }
    },
    refresh: () => {
      // Cached scopes with no visible consumer are invalidated, not fetched in the background.
      for (const key of versions.keys()) versions.set(key, (versions.get(key) ?? 0) + 1)
      set({ queries: {} })
      for (const { scope } of watched.values()) void get().load(scope)
    },
  }
})

let wired = false
export function wireArtifactEvents(): void {
  if (wired) return
  wired = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      useArtifacts.getState().refresh()
    }, 50)
  }
  on('outputs.changed', refresh)
  on('artifacts.changed', refresh)
}
