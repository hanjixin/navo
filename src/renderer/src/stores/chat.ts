import { create } from 'zustand'
import type { ChatEvent, Decision, PendingInterrupt, Thread, Todo, UIMessage } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { useModels } from '@/stores/models'
import { t } from '@shared/i18n'
import { errorMessage } from '@/lib/utils'

export type ChatMessage = UIMessage & { streaming?: boolean }

export interface ThreadView {
  recoverableMessageIds?: string[]
  loaded: boolean
  loadError: string | null
  messages: ChatMessage[]
  todos: Todo[]
  interrupt: PendingInterrupt | null
  running: boolean
  error: string | null
  /** when the current run started; used for a visible elapsed timer */
  runStartedAt: number | null
  /** last event received from the agent */
  lastActivityAt: number | null
  /** Langfuse trace of the latest run */
  traceUrl?: string
}

const emptyView = (): ThreadView => ({
  loaded: false,
  loadError: null,
  messages: [],
  todos: [],
  interrupt: null,
  running: false,
  error: null,
  runStartedAt: null,
  lastActivityAt: null,
})

// History is the ordered base; live messages replace matching entries and append
// new ones. A stream observed after opening a window may contain only a suffix,
// so never replace a complete persisted message with a shorter streaming fragment.
function mergeMessages(history: UIMessage[], live: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [...history]
  const indices = new Map(result.map((message, index) => [JSON.stringify([message.role, message.id]), index]))
  for (const message of live) {
    const key = JSON.stringify([message.role, message.id])
    const index = indices.get(key)
    if (index === undefined) {
      indices.set(key, result.length)
      result.push(message)
    } else {
      const saved = result[index]
      result[index] = message.streaming
        ? {
            ...saved,
            ...message,
            content: saved.content.length > message.content.length ? saved.content : message.content,
            reasoning: (saved.reasoning?.length ?? 0) > (message.reasoning?.length ?? 0) ? saved.reasoning : message.reasoning,
          }
        : message
    }
  }
  return result
}

interface ChatState {
  threads: Thread[] | undefined
  threadsError: string | null
  activeId: string | null
  /** undefined = all projects, null = unassigned, string = one project */
  projectFilterId: string | null | undefined
  views: Record<string, ThreadView>
  loadThreads: () => Promise<void>
  setProjectFilter: (projectId: string | null | undefined) => void
  select: (id: string | null) => void
  loadThread: (id: string) => Promise<void>
  resume: (id: string, decisions: Decision[], alwaysAllow?: string[]) => Promise<void>
  retrySubmission: (id: string, messageId: string) => Promise<void>
  newThread: (modelId?: string | null, projectId?: string | null, runtimeId?: string) => Promise<Thread>
  send: (text: string, images?: string[], fileIds?: string[]) => Promise<void>
  sendTo: (threadId: string, text: string, images?: string[], fileIds?: string[]) => Promise<void>
  /** files attached in the composer but not sent yet */
  draftFiles: string[]
  setDraftFiles: (ids: string[]) => void
  /** Branch from a user message: regenerate the answer, or resend with edited text */
  regenerate: (messageId: string, text?: string, threadId?: string) => Promise<void>
  handle: (e: ChatEvent) => void
}

export const useChat = create<ChatState>((set, get) => {
  let threadRequest = 0
  const stateRequests = new Map<string, number>()
  type VersionedField = 'messages' | 'running' | 'todos' | 'interrupt' | 'recoverableMessageIds'
  const eventVersions = new Map<string, Partial<Record<VersionedField, number>>>()
  const versionOf = (id: string, field: VersionedField) => eventVersions.get(id)?.[field] ?? 0
  const changed = (id: string, ...fields: VersionedField[]) => {
    const next = { ...eventVersions.get(id) }
    for (const field of fields) next[field] = (next[field] ?? 0) + 1
    eventVersions.set(id, next)
  }
  const patch = (id: string, fn: (v: ThreadView) => Partial<ThreadView>) =>
    set((s) => {
      const v = s.views[id] ?? emptyView()
      return { views: { ...s.views, [id]: { ...v, ...fn(v) } } }
    })

  const assertModelAvailable = async (modelId?: string | null) => {
    if (!useModels.getState().activeModels) await useModels.getState().load()
    const models = useModels.getState().activeModels
    if (modelId && !models?.some((model) => model.id === modelId)) throw new Error(t('当前模型已停用或不可用，请切换模型'))
    if (!models?.length) throw new Error(t('没有已启用的模型，请前往模型页面启用'))
  }

  return {
    threads: undefined,
    threadsError: null,
    activeId: null,
    projectFilterId: undefined,
    views: {},

    loadThreads: async () => {
      const request = ++threadRequest
      try {
        const threads = await call('threads.list')
        if (request === threadRequest) set({ threads, threadsError: null })
      } catch (e) {
        if (request === threadRequest) set({ threadsError: errorMessage(e) })
      }
    },

    select: (id) => {
      set({ activeId: id })
      if (id && !get().views[id]?.loaded) void get().loadThread(id)
    },

    setProjectFilter: (projectFilterId) => set({ projectFilterId }),

    loadThread: async (id) => {
      const request = (stateRequests.get(id) ?? 0) + 1
      stateRequests.set(id, request)
      const versions = { ...eventVersions.get(id) }
      patch(id, () => ({ loadError: null }))
      try {
        const st = await call('threads.state', id)
        if (stateRequests.get(id) !== request) return
        patch(id, (v) => {
          const received = (field: VersionedField) => (versions[field] ?? 0) !== versionOf(id, field)
          return {
            loaded: true,
            messages: received('messages') || v.running ? mergeMessages(st.messages, v.messages) : st.messages,
            // Only an event for a field supersedes that part of the snapshot.
            // A window joining mid-run may receive tokens without run_start.
            ...(received('todos') ? {} : { todos: st.todos }),
            ...(received('interrupt') ? {} : { interrupt: st.interrupt }),
            ...(received('recoverableMessageIds') ? {} : { recoverableMessageIds: st.recoverableMessageIds ?? [] }),
            ...(received('running') ? {} : { running: st.running, runStartedAt: st.running ? (v.runStartedAt ?? Date.now()) : null }),
          }
        })
      } catch (e) {
        if (stateRequests.get(id) === request) patch(id, () => ({ loadError: errorMessage(e) }))
      }
    },

    resume: async (id, decisions, alwaysAllow) => {
      const interruptId = get().views[id]?.interrupt?.id
      changed(id, 'running', 'interrupt')
      const runningVersion = versionOf(id, 'running')
      patch(id, () => ({ interrupt: null, running: true, error: null, runStartedAt: Date.now(), lastActivityAt: Date.now() }))
      try {
        await call('chat.resume', id, decisions, alwaysAllow, interruptId)
      } catch (e) {
        patch(id, () => ({
          ...(runningVersion === versionOf(id, 'running') ? { running: false, runStartedAt: null } : {}),
          error: errorMessage(e),
        }))
        await get().loadThread(id)
        throw e
      }
    },

    retrySubmission: async (id, messageId) => {
      const runningVersion = versionOf(id, 'running')
      try {
        await call('chat.retrySubmission', id, messageId)
        // The receipt acknowledges acceptance, not completion. run_end refreshes
        // the authoritative list, including messages that failed before checkpointing.
        if (get().views[id]?.running || runningVersion === versionOf(id, 'running')) {
          changed(id, 'recoverableMessageIds')
          patch(id, (v) => ({ recoverableMessageIds: v.recoverableMessageIds?.filter((pending) => pending !== messageId) }))
        }
      } catch (e) {
        await get().loadThread(id)
        throw e
      }
    },

    newThread: async (modelId, projectId, runtimeId = 'builtin') => {
      if (modelId && (runtimeId === 'builtin' || runtimeId === 'pi')) await assertModelAvailable(modelId)
      const t = await call('threads.create', runtimeId === 'builtin' || runtimeId === 'pi' ? (modelId ?? null) : null, projectId ?? null, runtimeId)
      set((s) => ({
        threads: [t, ...(s.threads ?? []).filter((thread) => thread.id !== t.id)],
        views: { ...s.views, [t.id]: { ...emptyView(), loaded: true } },
      }))
      get().select(t.id)
      return t
    },

    draftFiles: [],
    setDraftFiles: (draftFiles) => set({ draftFiles }),

    send: async (text, images, fileIds) => {
      let id = get().activeId
      if (!id) id = (await get().newThread()).id
      await get().sendTo(id, text, images, fileIds)
    },

    sendTo: async (id, text, images, fileIds) => {
      patch(id, () => ({ running: true, error: null, interrupt: null, runStartedAt: Date.now(), lastActivityAt: Date.now() }))
      try {
        const thread = get().threads?.find((thread) => thread.id === id)
        if (!thread?.runtimeId || thread.runtimeId === 'builtin' || thread.runtimeId === 'pi') await assertModelAvailable(thread?.modelId)
        await call('chat.send', id, text, images, fileIds)
      } catch (e) {
        patch(id, () => ({ running: false, runStartedAt: null, error: errorMessage(e) }))
        throw e
      }
    },

    regenerate: async (messageId, text, threadId) => {
      const id = threadId ?? get().activeId
      if (!id) return
      const runtimeId = get().threads?.find((thread) => thread.id === id)?.runtimeId ?? 'builtin'
      if (runtimeId !== 'builtin') return
      const v = get().views[id]
      const idx = v?.messages.findIndex((m) => m.id === messageId) ?? -1
      if (idx < 0) return
      try {
        await assertModelAvailable(get().threads?.find((thread) => thread.id === id)?.modelId)
      } catch (e) {
        patch(id, () => ({ error: errorMessage(e) }))
        return
      }
      changed(id, 'messages', 'running', 'interrupt', 'todos')
      stateRequests.set(id, (stateRequests.get(id) ?? 0) + 1)
      // drop the old branch from view; the main process re-emits the (possibly edited) user message
      patch(id, (cur) => ({ messages: cur.messages.slice(0, idx), running: true, error: null, interrupt: null, todos: [] }))
      try {
        await call('chat.regenerate', id, messageId, text)
      } catch (e) {
        patch(id, () => ({ running: false, runStartedAt: null, error: errorMessage(e) }))
        void get().loadThread(id)
      }
    },

    handle: (e) => {
      const id = e.threadId
      switch (e.type) {
        case 'run_start':
          changed(id, 'running', 'interrupt', 'recoverableMessageIds')
          patch(id, () => ({ recoverableMessageIds: [], running: true, error: null, interrupt: null, runStartedAt: Date.now(), lastActivityAt: Date.now() }))
          break
        case 'token':
          changed(id, 'messages')
          patch(id, (v) => {
            const i = v.messages.findIndex((m) => m.id === e.messageId)
            const field = e.reasoning ? 'reasoning' : 'content'
            if (i >= 0) {
              const m = v.messages[i]
              const next = [...v.messages]
              next[i] = { ...m, [field]: (m[field] ?? '') + e.text, streaming: true }
              return { messages: next, lastActivityAt: Date.now() }
            }
            const fresh: ChatMessage = { id: e.messageId, role: 'assistant', content: '', ns: e.ns, streaming: true }
            fresh[field] = e.text
            return { messages: [...v.messages, fresh], lastActivityAt: Date.now() }
          })
          break
        case 'message':
          changed(id, 'messages')
          patch(id, (v) => {
            const msg = e.message
            let i = v.messages.findIndex((m) => m.id === msg.id && m.role === msg.role)
            // provider message ids can differ between stream chunks and the final message
            if (i < 0 && msg.role === 'assistant' && !msg.toolCalls?.length && (msg.content.trim() || msg.reasoning?.trim()))
              i = v.messages.findIndex((m) => m.streaming && m.role === 'assistant' && (m.ns ?? '') === (msg.ns ?? ''))
            const next = [...v.messages]
            if (i >= 0) next[i] = { ...msg, streaming: false }
            else next.push(msg)
            return { messages: next, lastActivityAt: Date.now() }
          })
          break
        case 'todos':
          changed(id, 'todos')
          patch(id, () => ({ todos: e.todos, lastActivityAt: Date.now() }))
          break
        case 'interrupt':
          changed(id, 'interrupt')
          patch(id, () => ({ interrupt: e.interrupt, lastActivityAt: Date.now() }))
          break
        case 'interrupt_cleared':
          changed(id, 'interrupt')
          patch(id, (view) => (view.interrupt?.id === e.interruptId ? { interrupt: null, lastActivityAt: Date.now() } : {}))
          break
        case 'error':
          patch(id, () => ({ error: e.error, lastActivityAt: Date.now() }))
          break
        case 'run_end':
          changed(id, 'running', 'messages', 'recoverableMessageIds')
          patch(id, (v) => ({
            running: false,
            runStartedAt: null,
            lastActivityAt: Date.now(),
            traceUrl: e.traceUrl ?? v.traceUrl,
            messages: v.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          }))
          if (get().activeId === id || get().views[id]?.loaded) void get().loadThread(id)
          break
      }
    },
  }
})

let wired = false
export function wireChatEvents(): void {
  if (wired) return
  wired = true
  on('chat.event', (e) => useChat.getState().handle(e))
  on('threads.changed', () => void useChat.getState().loadThreads())
}
