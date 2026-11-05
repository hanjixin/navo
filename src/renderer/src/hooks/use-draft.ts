import { useEffect, useMemo } from 'react'
import type { DraftScope } from '@shared/reliability'
import { draftKey, useDrafts } from '@/stores/drafts'

export function useDraft(scope: DraftScope) {
  const key = draftKey(scope)
  // Scope identity must be stable so leaving a page flushes only that page's draft.
  const stable = useMemo(() => scope, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const entry = useDrafts((s) => s.entries[key])
  useEffect(() => {
    void useDrafts.getState().load(stable)
    return () => {
      void useDrafts
        .getState()
        .flush(stable)
        .catch(() => undefined)
    }
  }, [stable])
  return {
    data: entry?.data,
    loading: !entry || entry.loading,
    error: entry?.error,
    scope: stable,
    patch: (content: Parameters<ReturnType<typeof useDrafts.getState>['patch']>[1]) => useDrafts.getState().patch(stable, content),
  }
}
