import { create } from 'zustand'
import type { Artifact } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

export interface ArtifactScope {
  projectId?: string | null
  threadId?: string
}
export interface ArtifactQuery {
  items?: Artifact[]
  loading: boolean
  error: string | null
}
export const artifactScopeKey = ({ projectId, threadId }: ArtifactScope): string =>
  threadId ? `thread:${threadId}` : projectId === undefined ? 'all' : projectId === null ? 'unassigned' : `project:${projectId}`

interface ArtifactState {
  queries: Record<string, ArtifactQuery>
  load: (scope?: ArtifactScope) => Promise<void>
  watch: (scope: ArtifactScope) => () => void
  refresh: () => void
}

export const useArtifacts = create<ArtifactState>((set, get) => {
  const versions = new Map<string, number>()
  const watched = new Map<string, { scope: ArtifactScope; count: number }>()
  return {
    queries: {},
    load: async (scope = {}) => {
      const key = artifactScopeKey(scope)
      const version = (versions.get(key) ?? 0) + 1
      versions.set(key, version)
      set((s) => ({ queries: { ...s.queries, [key]: { items: s.queries[key]?.items, loading: true, error: null } } }))
      try {
        const all = await call('artifacts.list', scope.projectId)
        if (versions.get(key) !== version) return
        const items = scope.threadId ? all.filter((a) => a.threadId === scope.threadId) : all
        set((s) => ({ queries: { ...s.queries, [key]: { items, loading: false, error: null } } }))
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
