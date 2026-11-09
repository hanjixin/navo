import { create } from 'zustand'
import type { ChatDraft, DraftScope, ProjectFileReference, ChatSubmitInput } from '@shared/reliability'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { toast } from 'sonner'
import { t } from '@shared/i18n'

export const draftKey = (scope: DraftScope) =>
  JSON.stringify([scope.surface, scope.threadId ? 'thread' : scope.projectId ? 'project' : 'new', scope.threadId || scope.projectId || ''])
export function mainDraftScope(projectId?: string, threadId?: string): DraftScope {
  return threadId ? { surface: 'main', threadId } : projectId ? { surface: 'main', projectId } : { surface: 'main' }
}
type Entry = { data: ChatDraft; revision: number; savedRevision: number; loading: boolean; error: string | null }
type Content = Pick<ChatDraft, 'text' | 'fileIds' | 'projectFiles' | 'modelId' | 'runtimeId'>
const empty = (scope: DraftScope): ChatDraft => ({
  scope,
  text: '',
  fileIds: [],
  projectFiles: [],
  modelId: null,
  runtimeId: 'builtin',
  version: 0,
  updatedAt: 0,
})
const editorId = crypto.randomUUID()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const loads = new Map<string, Promise<void>>()
const saves = new Map<string, Promise<ChatDraft>>()
const requests = new Map<string, { revision: number; input: ChatSubmitInput }>()

interface DraftState {
  entries: Record<string, Entry>
  load(scope: DraftScope): Promise<void>
  patch(scope: DraftScope, content: Partial<Content>): void
  flush(scope: DraftScope): Promise<ChatDraft>
  accepted(scope: DraftScope, revision: number): Promise<void>
  addFiles(scope: DraftScope, ids: string[]): Promise<void>
  addProjectFile(scope: DraftScope, ref: ProjectFileReference): Promise<void>
  transfer(source: DraftScope, target: DraftScope): Promise<boolean>
}

export const useDrafts = create<DraftState>((set, get) => ({
  entries: {},
  load: async (scope) => {
    const key = draftKey(scope)
    if (loads.has(key)) return loads.get(key)
    const existing = get().entries[key]
    if (existing && !existing.loading && (!existing.error || existing.revision > existing.savedRevision)) return
    set((s) => ({
      entries: { ...s.entries, [key]: { ...(s.entries[key] ?? { data: empty(scope), revision: 0, savedRevision: 0 }), loading: true, error: null } },
    }))
    const work = (async () => {
      try {
        const data = await call('drafts.get', scope)
        set((s) => ({
          entries: {
            ...s.entries,
            [key]: {
              ...s.entries[key],
              data:
                data.version < s.entries[key].data.version
                  ? s.entries[key].data
                  : s.entries[key].revision
                    ? { ...s.entries[key].data, version: data.version }
                    : data,
              loading: false,
              error: null,
            },
          },
        }))
      } catch (e) {
        set((s) => ({ entries: { ...s.entries, [key]: { ...s.entries[key], loading: false, error: errorMessage(e) } } }))
      }
    })()
    loads.set(key, work)
    try {
      await work
    } finally {
      loads.delete(key)
    }
  },
  patch: (scope, content) => {
    const key = draftKey(scope)
    set((s) => {
      const current = s.entries[key] ?? { data: empty(scope), revision: 0, savedRevision: 0, loading: false, error: null }
      return {
        entries: {
          ...s.entries,
          [key]: {
            ...current,
            data: { ...current.data, ...content, editorId, editRevision: current.revision + 1 },
            revision: current.revision + 1,
            error: null,
          },
        },
      }
    })
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        void get()
          .flush(scope)
          .catch(() => undefined)
      }, 150),
    )
  },
  flush: async (scope) => {
    const key = draftKey(scope)
    clearTimeout(timers.get(key))
    timers.delete(key)
    await get().load(scope)
    if (get().entries[key].error && /Draft changed/.test(get().entries[key].error!)) throw new Error(get().entries[key].error!)
    if (saves.has(key)) {
      await saves.get(key)
      return get().flush(scope)
    }
    const work = (async () => {
      let conflicts = 0
      while (true) {
        const current = get().entries[key]
        if (current.revision === current.savedRevision) return current.data
        try {
          const data = await call('drafts.save', { ...current.data, expectedVersion: current.data.version })
          set((s) => ({
            entries: {
              ...s.entries,
              [key]: {
                ...s.entries[key],
                data: { ...s.entries[key].data, version: data.version, updatedAt: data.updatedAt },
                savedRevision: current.revision,
                error: null,
              },
            },
          }))
        } catch (e) {
          const submitted = requests.get(key)
          if (/Draft changed/.test(errorMessage(e)) && submitted && current.revision > submitted.revision && conflicts++ < 2) {
            const fresh = await call('drafts.get', scope)
            set((s) => ({ entries: { ...s.entries, [key]: { ...s.entries[key], data: { ...s.entries[key].data, version: fresh.version } } } }))
            continue
          }
          set((s) => ({ entries: { ...s.entries, [key]: { ...s.entries[key], error: errorMessage(e) } } }))
          throw e
        }
      }
    })()
    saves.set(key, work)
    try {
      return await work
    } finally {
      saves.delete(key)
    }
  },
  accepted: async (scope, revision) => {
    const key = draftKey(scope)
    const fresh = await call('drafts.get', scope)
    set((s) => {
      const current = s.entries[key]
      if (!current || fresh.version < current.data.version) return s
      return {
        entries: {
          ...s.entries,
          [key]:
            current.revision === revision
              ? { data: fresh, revision: revision + 1, savedRevision: revision + 1, loading: false, error: null }
              : { ...current, data: { ...current.data, version: fresh.version } },
        },
      }
    })
    if (requests.get(key)?.revision === revision) requests.delete(key)
  },
  addFiles: async (scope, ids) => {
    await get().load(scope)
    get().patch(scope, { fileIds: [...new Set([...get().entries[draftKey(scope)].data.fileIds, ...ids])] })
    await get().flush(scope)
  },
  addProjectFile: async (scope, ref) => {
    await get().load(scope)
    const items = get().entries[draftKey(scope)].data.projectFiles
    if (!items.some((item) => item.projectId === ref.projectId && item.root === ref.root && item.path === ref.path))
      get().patch(scope, { projectFiles: [...items, ref] })
    await get().flush(scope)
  },
  transfer: async (source, target) => {
    let sourceEntry: Entry
    do {
      await get().flush(source)
      sourceEntry = get().entries[draftKey(source)]
    } while (sourceEntry.revision !== sourceEntry.savedRevision)
    const from = sourceEntry.data
    const sourceRevision = sourceEntry.revision
    const targetRevision = get().entries[draftKey(target)]?.revision ?? 0
    const result = await call('drafts.move', source, target, from.version)
    if (!result.moved) return false
    for (const scope of [source, target]) {
      const data = await call('drafts.get', scope)
      const key = draftKey(scope),
        revision = scope === source ? sourceRevision : targetRevision
      set((s) => {
        const current = s.entries[key]
        if (current && current.data.version > data.version) return s
        return {
          entries: {
            ...s.entries,
            [key]:
              current && current.revision !== revision
                ? { ...current, data: { ...current.data, version: data.version }, error: null }
                : { data, revision, savedRevision: revision, loading: false, error: null },
          },
        }
      })
      if (get().entries[key].revision !== get().entries[key].savedRevision) await get().flush(scope)
    }
    return true
  },
}))

export async function submitDraft(scope: DraftScope, context: { threadId?: string; projectId?: string; modelId?: string | null; runtimeId?: string } = {}) {
  const key = draftKey(scope)
  let request = requests.get(key)
  let current = useDrafts.getState().entries[key]
  if (!request || request.revision !== current?.revision) {
    do {
      await useDrafts.getState().flush(scope)
      current = useDrafts.getState().entries[key]
    } while (current.revision !== current.savedRevision)
  }
  const { data, revision } = current
  if (!request || request.revision !== revision) {
    request = {
      revision,
      input: {
        ...context,
        requestId: crypto.randomUUID(),
        text: data.text,
        fileIds: [...data.fileIds],
        projectFiles: data.projectFiles.map((file) => ({ ...file })),
        modelId: context.modelId === undefined ? data.modelId : context.modelId,
        runtimeId: context.runtimeId ?? data.runtimeId ?? 'builtin',
        draft: { scope: { ...scope }, version: data.version },
      },
    }
    requests.set(key, request)
  }
  const receipt = await call('chat.submit', request.input)
  await useDrafts.getState().accepted(scope, revision)
  return receipt
}

let wired = false
export function wireDraftEvents() {
  if (wired) return
  wired = true
  on('quick.transferDraft', ({ source, target }) => {
    // The receiving window owns its unsaved edits: flush them before the atomic empty check.
    void (async () => {
      await useDrafts.getState().flush(target)
      if (!(await useDrafts.getState().transfer(source, target))) toast(t('主窗口已有草稿，已保留两边内容'))
    })().catch((e) => toast.error(t('操作失败'), { description: errorMessage(e) }))
  })
  on('drafts.changed', (scope) => {
    const key = draftKey(scope),
      current = useDrafts.getState().entries[key]
    if (!current || current.loading || current.revision !== current.savedRevision || saves.has(key)) return
    void call('drafts.get', scope).then((data) =>
      useDrafts.setState((s) => {
        const latest = s.entries[key]
        return latest && latest.revision === current.revision && data.version >= latest.data.version
          ? { entries: { ...s.entries, [key]: { ...latest, data } } }
          : s
      }),
    )
  })
  window.addEventListener('beforeunload', (event) => {
    let failed = false
    for (const entry of Object.values(useDrafts.getState().entries)) {
      if (entry.revision === entry.savedRevision) continue
      try {
        window.api.flushDraft(entry.data)
      } catch (error) {
        failed = true
        const key = draftKey(entry.data.scope)
        useDrafts.setState((s) => ({ entries: { ...s.entries, [key]: { ...s.entries[key], error: errorMessage(error) } } }))
      }
    }
    if (failed) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
  window.addEventListener('blur', () => {
    for (const entry of Object.values(useDrafts.getState().entries))
      if (entry.revision !== entry.savedRevision)
        void useDrafts
          .getState()
          .flush(entry.data.scope)
          .catch(() => undefined)
  })
}
