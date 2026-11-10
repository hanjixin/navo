import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInterrupt } from '@shared/types'

vi.mock('@/lib/ipc', () => ({ call: vi.fn(), on: vi.fn(() => () => {}) }))
import { useChat } from '@/stores/chat'

const interrupt = (id: string): PendingInterrupt => ({
  id,
  actionRequests: [{ name: 'write_file', args: { file_path: '/workspace/note.md', content: 'test' } }],
  allowedDecisions: [['approve', 'reject']],
})
beforeEach(() => useChat.setState({ threads: [], views: {}, activeId: 'thread' }))

describe('runtime approval invalidation', () => {
  it('clears the disconnected request without dropping messages or changing execution state', () => {
    const store = useChat.getState()
    store.handle({ type: 'run_start', threadId: 'thread', runId: 'run' })
    store.handle({ type: 'message', threadId: 'thread', message: { id: 'message', role: 'assistant', content: 'Waiting for confirmation' } })
    store.handle({ type: 'interrupt', threadId: 'thread', interrupt: interrupt('old') })
    store.handle({ type: 'run_end', threadId: 'thread', runId: 'run' })
    store.handle({ type: 'interrupt_cleared', threadId: 'thread', interruptId: 'old' })
    expect(useChat.getState().views.thread.interrupt).toBeNull()
    expect(useChat.getState().views.thread.running).toBe(false)
    expect(useChat.getState().views.thread.messages.map((message) => message.id)).toEqual(['message'])
  })

  it('ignores late invalidation of a previous approval after a new one has arrived', () => {
    const store = useChat.getState()
    store.handle({ type: 'interrupt', threadId: 'thread', interrupt: interrupt('new') })
    store.handle({ type: 'interrupt', threadId: 'another', interrupt: interrupt('old') })
    store.handle({ type: 'interrupt_cleared', threadId: 'thread', interruptId: 'old' })
    expect(useChat.getState().views.thread.interrupt?.id).toBe('new')
    expect(useChat.getState().views.another.interrupt?.id).toBe('old')
    store.handle({ type: 'interrupt_cleared', threadId: 'another', interruptId: 'old' })
    expect(useChat.getState().views.another.interrupt).toBeNull()
    expect(useChat.getState().views.thread.interrupt?.id).toBe('new')
  })
})

describe('runtime stream and tool ordering', () => {
  it('does not replace streaming text when a Navo tool event arrives before the final answer', () => {
    const store = useChat.getState()
    store.handle({ type: 'token', threadId: 'thread', messageId: 'stream-id', text: 'I will check ' })
    store.handle({
      type: 'message',
      threadId: 'thread',
      message: {
        id: 'tool-call',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'browser_snapshot', args: {}, activity: { kind: 'tool', status: 'running' } }],
      },
    })
    expect(useChat.getState().views.thread.messages.map((message) => message.id)).toEqual(['stream-id', 'tool-call'])
    store.handle({ type: 'token', threadId: 'thread', messageId: 'stream-id', text: 'the page.' })
    expect(useChat.getState().views.thread.messages[0].content).toBe('I will check the page.')
    store.handle({ type: 'message', threadId: 'thread', message: { id: 'final-id', role: 'assistant', content: 'I will check the page.' } })
    expect(useChat.getState().views.thread.messages.map((message) => message.id)).toEqual(['final-id', 'tool-call'])
    expect(useChat.getState().views.thread.messages[0].streaming).toBe(false)
  })

  it('preserves streaming reasoning when a standalone diagnostic arrives', () => {
    const store = useChat.getState()
    store.handle({ type: 'token', threadId: 'thread', messageId: 'reasoning-id', text: 'Considering the task', reasoning: true })
    store.handle({ type: 'message', threadId: 'thread', message: { id: 'warning', role: 'assistant', content: '', runtimeWarning: 'runtime_disconnected' } })
    expect(useChat.getState().views.thread.messages.map((message) => message.id)).toEqual(['reasoning-id', 'warning'])
    expect(useChat.getState().views.thread.messages[0].reasoning).toBe('Considering the task')
    store.handle({ type: 'message', threadId: 'thread', message: { id: 'reasoning-final', role: 'assistant', content: '', reasoning: 'Considering the task' } })
    expect(useChat.getState().views.thread.messages.map((message) => message.id)).toEqual(['reasoning-final', 'warning'])
  })
})
