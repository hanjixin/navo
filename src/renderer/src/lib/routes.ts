import type { Thread } from '@shared/types'

export const projectPath = (id: string): string => `/projects/${encodeURIComponent(id)}`

/** Conversation ownership determines its canonical, reloadable URL. */
export const threadPath = (thread: Pick<Thread, 'id' | 'projectId'>): string =>
  thread.projectId ? `${projectPath(thread.projectId)}/chat/${encodeURIComponent(thread.id)}` : `/chat/${encodeURIComponent(thread.id)}`

/** Read the current HashRouter query when handling successive events before React commits a navigation. */
export function currentSearchParams(): URLSearchParams {
  const query = window.location.hash.indexOf('?')
  return new URLSearchParams(query < 0 ? '' : window.location.hash.slice(query + 1))
}
