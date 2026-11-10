import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, PendingInterrupt, ThreadState } from '@shared/types'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/lib/ipc', () => ({ call: mocks.call, on: vi.fn(() => () => {}) }))
import { useChat } from '@/stores/chat'

const snapshot = (overrides: Partial<ThreadState> = {}): ThreadState => ({
  messages: [{ id: 'history', role: 'user', content: 'Earlier question' }],
  todos: [],
  interrupt: null,
  running: false,
  recoverableMessageIds: [],
  ...overrides,
})
const approval: PendingInterrupt = {
  id: 'approval',
  actionRequests: [{ name: 'write_file', args: { file_path: '/workspace/file.txt', content: 'hello' } }],
  allowedDecisions: [['approve', 'reject']],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const state = () => useChat.getState().views.thread
const start = () => useChat.getState().handle({ type: 'run_start', threadId: 'thread', runId: 'run' })
const end = () => useChat.getState().handle({ type: 'run_end', threadId: 'thread', runId: 'run' })

beforeEach(() => {
  useChat.setState({ views: {}, threads: [], activeId: 'thread' })
  mocks.call.mockReset().mockResolvedValue(snapshot())
})

describe('chat snapshot and event ordering', () => {
  it('defers loading an unvisited background conversation until it is selected', async () => {
    useChat.setState({ activeId: 'another' })
    start()
    end()
    expect(mocks.call).not.toHaveBeenCalledWith('threads.state', 'thread')
    expect(state().loaded).toBe(false)
    expect(state().running).toBe(false)
    useChat.getState().select('thread')
    await vi.waitFor(() => expect(state().loaded).toBe(true))
    expect(mocks.call).toHaveBeenCalledWith('threads.state', 'thread')
  })

  it('refreshes an already loaded conversation after it finishes in the background', async () => {
    await useChat.getState().loadThread('thread')
    useChat.setState({ activeId: 'another' })
    mocks.call.mockClear()
    start()
    end()
    expect(mocks.call).toHaveBeenCalledWith('threads.state', 'thread')
  })

  it.each<ChatEvent>([
    { type: 'token', threadId: 'thread', messageId: 'answer', text: 'live text' },
    { type: 'message', threadId: 'thread', message: { id: 'answer', role: 'assistant', content: 'live text' } },
  ])('accepts lifecycle state when joining mid-run and receiving only $type', async (event) => {
    const pending = deferred<ThreadState>()
    mocks.call.mockReturnValue(pending.promise)
    const loading = useChat.getState().loadThread('thread')
    useChat.getState().handle(event)
    const todos: ThreadState['todos'] = [{ content: 'Inspect files', status: 'in_progress' }]
    pending.resolve(snapshot({ running: true, todos, interrupt: approval, recoverableMessageIds: ['saved'] }))
    await loading
    expect(state().running).toBe(true)
    expect(state().runStartedAt).not.toBeNull()
    expect(state().todos).toEqual(todos)
    expect(state().interrupt).toEqual(approval)
    expect(state().recoverableMessageIds).toEqual(['saved'])
    expect(state().messages.map((message) => message.id)).toEqual(['history', 'answer'])
  })

  it('updates unrelated snapshot fields while preserving newer todos and approval invalidation', async () => {
    const pending = deferred<ThreadState>()
    mocks.call.mockReturnValue(pending.promise)
    const loading = useChat.getState().loadThread('thread')
    const todos: ThreadState['todos'] = [{ content: 'Finished', status: 'completed' }]
    useChat.getState().handle({ type: 'todos', threadId: 'thread', todos })
    useChat.getState().handle({ type: 'interrupt_cleared', threadId: 'thread', interruptId: approval.id })
    pending.resolve(snapshot({ running: true, interrupt: approval, recoverableMessageIds: ['saved'] }))
    await loading
    expect(state().todos).toEqual(todos)
    expect(state().interrupt).toBeNull()
    expect(state().running).toBe(true)
    expect(state().recoverableMessageIds).toEqual(['saved'])
  })

  it('loads old history alongside live messages and merges the same message only once', async () => {
    start()
    useChat.getState().handle({ type: 'token', threadId: 'thread', messageId: 'answer', text: 'new answer' })
    mocks.call.mockResolvedValue(snapshot({ running: true, messages: [...snapshot().messages, { id: 'answer', role: 'assistant', content: 'new' }] }))
    await useChat.getState().loadThread('thread')
    expect(state().messages.map((message) => message.id)).toEqual(['history', 'answer'])
    expect(state().messages[1].content).toBe('new answer')
    expect(state().loaded).toBe(true)
  })

  it('does not truncate complete persisted content when the window only observed a stream suffix', async () => {
    start()
    useChat.getState().handle({ type: 'token', threadId: 'thread', messageId: 'answer', text: 'suffix' })
    mocks.call.mockResolvedValue(snapshot({ running: true, messages: [{ id: 'answer', role: 'assistant', content: 'complete prefix and suffix' }] }))
    await useChat.getState().loadThread('thread')
    expect(state().messages[0].content).toBe('complete prefix and suffix')
  })

  it('ignores a running snapshot arriving after run_end and its newer refresh', async () => {
    const old = deferred<ThreadState>()
    const fresh = deferred<ThreadState>()
    mocks.call.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    start()
    const loading = useChat.getState().loadThread('thread')
    end()
    fresh.resolve(snapshot())
    await vi.waitFor(() => expect(state().loaded).toBe(true))
    old.resolve(snapshot({ running: true, interrupt: approval }))
    await loading
    expect(state().running).toBe(false)
    expect(state().runStartedAt).toBeNull()
    expect(state().interrupt).toBeNull()
  })

  it('does not restore an approval cleared while a state request was pending', async () => {
    useChat.getState().handle({ type: 'interrupt', threadId: 'thread', interrupt: approval })
    const pending = deferred<ThreadState>()
    mocks.call.mockReturnValue(pending.promise)
    const loading = useChat.getState().loadThread('thread')
    useChat.getState().handle({ type: 'interrupt_cleared', threadId: 'thread', interruptId: approval.id })
    pending.resolve(snapshot({ interrupt: approval }))
    await loading
    expect(state().interrupt).toBeNull()
    expect(state().messages[0].id).toBe('history')
  })

  it('preserves a run that starts while an idle snapshot is pending', async () => {
    const pending = deferred<ThreadState>()
    mocks.call.mockReturnValue(pending.promise)
    const loading = useChat.getState().loadThread('thread')
    start()
    pending.resolve(snapshot())
    await loading
    expect(state().running).toBe(true)
  })
})

describe('approval and saved-message recovery', () => {
  it('does not reset a newer run_start when a resume IPC receipt fails', async () => {
    useChat.getState().handle({ type: 'interrupt', threadId: 'thread', interrupt: approval })
    const receipt = deferred<void>()
    const refreshed = deferred<ThreadState>()
    mocks.call.mockReturnValueOnce(receipt.promise).mockReturnValueOnce(refreshed.promise)
    const resuming = useChat.getState().resume('thread', [{ type: 'approve' }])
    const rejected = expect(resuming).rejects.toThrow('receipt lost')
    start()
    const startedAt = state().runStartedAt
    receipt.reject(new Error('receipt lost'))
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledWith('threads.state', 'thread'))
    expect(state().running).toBe(true)
    expect(state().runStartedAt).toBe(startedAt)
    refreshed.resolve(snapshot({ running: true }))
    await rejected
    expect(state().running).toBe(true)
    expect(state().interrupt).toBeNull()
  })

  it('reloads the backend approval after resume is rejected so it can be retried', async () => {
    useChat.getState().handle({ type: 'interrupt', threadId: 'thread', interrupt: approval })
    mocks.call.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(snapshot({ interrupt: approval }))
    await expect(useChat.getState().resume('thread', [{ type: 'approve' }])).rejects.toThrow('temporary failure')
    expect(mocks.call).toHaveBeenCalledWith('chat.resume', 'thread', [{ type: 'approve' }], undefined, approval.id)
    expect(state().interrupt).toEqual(approval)
    expect(state().running).toBe(false)
    expect(state().error).toBe('temporary failure')
  })

  it('does not resurrect an approval that the backend has invalidated', async () => {
    useChat.getState().handle({ type: 'interrupt', threadId: 'thread', interrupt: approval })
    mocks.call.mockRejectedValueOnce(new Error('no longer pending')).mockResolvedValueOnce(snapshot())
    await expect(useChat.getState().resume('thread', [{ type: 'approve' }])).rejects.toThrow()
    expect(state().interrupt).toBeNull()
  })

  it('clears an accepted retry, then refreshes recoverability after execution finishes', async () => {
    mocks.call.mockResolvedValueOnce(snapshot({ recoverableMessageIds: ['saved'] }))
    await useChat.getState().loadThread('thread')
    await useChat.getState().retrySubmission('thread', 'saved')
    expect(state().recoverableMessageIds).toEqual([])
    start()
    mocks.call.mockResolvedValueOnce(snapshot({ recoverableMessageIds: ['saved'] }))
    end()
    await vi.waitFor(() => expect(state().recoverableMessageIds).toEqual(['saved']))
  })

  it('does not let a late acceptance receipt clear recovery discovered after run_end', async () => {
    const accepted = deferred<void>()
    mocks.call.mockReturnValueOnce(accepted.promise)
    const retrying = useChat.getState().retrySubmission('thread', 'saved')
    start()
    mocks.call.mockResolvedValueOnce(snapshot({ recoverableMessageIds: ['saved'] }))
    end()
    await vi.waitFor(() => expect(state().recoverableMessageIds).toEqual(['saved']))
    accepted.resolve()
    await retrying
    expect(state().recoverableMessageIds).toEqual(['saved'])
  })
})
