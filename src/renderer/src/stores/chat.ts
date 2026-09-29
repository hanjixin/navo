import { create } from 'zustand'
import type { ChatEvent, PendingInterrupt, Thread, Todo, UIMessage } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

export type ChatMessage = UIMessage & { streaming?: boolean }

export interface ThreadView {
  loaded: boolean
  loadError: string | null
  messages: ChatMessage[]
  todos: Todo[]
  interrupt: PendingInterrupt | null
  running: boolean
  error: string | null
  /** Langfuse trace of the latest run */
  traceUrl?: string
}

const emptyView = (): ThreadView => ({ loaded: false, loadError: null, messages: [], todos: [], interrupt: null, running: false, error: null })

interface ChatState {
  threads: Thread[] | undefined
  threadsError: string | null
  activeId: string | null
  views: Record<string, ThreadView>
  loadThreads: () => Promise<void>
  select: (id: string | null) => void
  loadThread: (id: string) => Promise<void>
  newThread: (modelId?: string | null) => Promise<Thread>
  send: (text: string, images?: string[], fileIds?: string[]) => Promise<void>
  /** files attached in the composer but not sent yet */
  draftFiles: string[]
  setDraftFiles: (ids: string[]) => void
  /** Branch from a user message: regenerate the answer, or resend with edited text */
  regenerate: (messageId: string, text?: string) => Promise<void>
  handle: (e: ChatEvent) => void
}

export const useChat = create<ChatState>((set, get) => {
  const patch = (id: string, fn: (v: ThreadView) => Partial<ThreadView>) =>
    set((s) => {
      const v = s.views[id] ?? emptyView()
      return { views: { ...s.views, [id]: { ...v, ...fn(v) } } }
    })

  return {
    threads: undefined,
    threadsError: null,
    activeId: null,
    views: {},

    loadThreads: async () => {
      try {
        const threads = await call('threads.list')
        set({ threads, threadsError: null })
      } catch (e) {
        set({ threadsError: errorMessage(e) })
      }
    },

    select: (id) => {
      set({ activeId: id })
      if (id && !get().views[id]?.loaded) void get().loadThread(id)
    },

    loadThread: async (id) => {
      patch(id, () => ({ loadError: null }))
      try {
        const st = await call('threads.state', id)
        patch(id, (v) => ({
          loaded: true,
          messages: v.running ? v.messages : st.messages,
          todos: st.todos,
          interrupt: st.interrupt,
          running: st.running || v.running,
        }))
      } catch (e) {
        patch(id, () => ({ loadError: errorMessage(e) }))
      }
    },

    newThread: async (modelId) => {
      const t = await call('threads.create', modelId ?? null)
      set((s) => ({ threads: [t, ...(s.threads ?? [])], views: { ...s.views, [t.id]: { ...emptyView(), loaded: true } } }))
      get().select(t.id)
      return t
    },

    draftFiles: [],
    setDraftFiles: (draftFiles) => set({ draftFiles }),

    send: async (text, images, fileIds) => {
      let id = get().activeId
      if (!id) id = (await get().newThread()).id
      patch(id, () => ({ running: true, error: null, interrupt: null }))
      try {
        await call('chat.send', id, text, images, fileIds)
      } catch (e) {
        patch(id!, () => ({ running: false, error: errorMessage(e) }))
      }
    },

    regenerate: async (messageId, text) => {
      const id = get().activeId
      if (!id) return
      const v = get().views[id]
      const idx = v?.messages.findIndex((m) => m.id === messageId) ?? -1
      if (idx < 0) return
      // drop the old branch from view; the main process re-emits the (possibly edited) user message
      patch(id, (cur) => ({ messages: cur.messages.slice(0, idx), running: true, error: null, interrupt: null, todos: [] }))
      try {
        await call('chat.regenerate', id, messageId, text)
      } catch (e) {
        patch(id, () => ({ running: false, error: errorMessage(e) }))
        void get().loadThread(id)
      }
    },

    handle: (e) => {
      const id = e.threadId
      switch (e.type) {
        case 'run_start':
          patch(id, () => ({ running: true, error: null, interrupt: null }))
          break
        case 'token':
          patch(id, (v) => {
            const i = v.messages.findIndex((m) => m.id === e.messageId)
            const field = e.reasoning ? 'reasoning' : 'content'
            if (i >= 0) {
              const m = v.messages[i]
              const next = [...v.messages]
              next[i] = { ...m, [field]: (m[field] ?? '') + e.text, streaming: true }
              return { messages: next }
            }
            const fresh: ChatMessage = { id: e.messageId, role: 'assistant', content: '', ns: e.ns, streaming: true }
            fresh[field] = e.text
            return { messages: [...v.messages, fresh] }
          })
          break
        case 'message':
          patch(id, (v) => {
            const msg = e.message
            let i = v.messages.findIndex((m) => m.id === msg.id && m.role === msg.role)
            // provider message ids can differ between stream chunks and the final message
            if (i < 0 && msg.role === 'assistant') i = v.messages.findIndex((m) => m.streaming && m.role === 'assistant' && (m.ns ?? '') === (msg.ns ?? ''))
            const next = [...v.messages]
            if (i >= 0) next[i] = { ...msg, streaming: false }
            else next.push(msg)
            return { messages: next }
          })
          break
        case 'todos':
          patch(id, () => ({ todos: e.todos }))
          break
        case 'interrupt':
          patch(id, () => ({ interrupt: e.interrupt }))
          break
        case 'error':
          patch(id, () => ({ error: e.error }))
          break
        case 'run_end':
          patch(id, (v) => ({
            running: false,
            traceUrl: e.traceUrl ?? v.traceUrl,
            messages: v.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          }))
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
