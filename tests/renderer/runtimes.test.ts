import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeInfo } from '@shared/agent-runtime'
import type { Thread } from '@shared/types'

const { call, on } = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn<(method: string, listener: () => void) => () => void>(() => () => {}) }))
vi.mock('@/lib/ipc', () => ({ call, on }))
vi.mock('@/lib/utils', () => ({ errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }))
vi.mock('@shared/i18n', () => ({ t: (text: string) => text }))
import { useRuntimes, wireRuntimeEvents } from '@/stores/runtimes'
import { useChat } from '@/stores/chat'
import { useModels } from '@/stores/models'

const runtime = (enabled: boolean): AgentRuntimeInfo => ({
  profile: { id: 'pi', kind: 'pi', name: 'Pi', enabled, command: 'pi', args: [] },
  capabilities: { navoTools: false, nativeTools: false, approvals: false, images: false, resume: true, fork: false, tokenStreaming: true },
})
const thread: Thread = { id: 'thread', title: 'External', runtimeId: 'pi', modelId: null, projectId: null, createdAt: 1, updatedAt: 1 }
beforeEach(() => {
  call.mockReset()
  useRuntimes.setState({ runtimes: undefined, error: null })
  useModels.setState({
    activeModels: [
      {
        id: 'navo-model',
        displayName: 'Navo model',
        model: 'model',
        providerId: 'provider',
        enabled: true,
        isDefault: true,
        supportsTools: true,
        supportsVision: false,
      },
    ],
    models: [],
    providers: [],
  })
  useChat.setState({ threads: [thread], activeId: 'thread', views: {} })
})

describe('renderer runtime selection', () => {
  it('keeps the latest enabled state when an old list request completes late', async () => {
    let resolve!: (value: AgentRuntimeInfo[]) => void
    call
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        }),
      )
      .mockResolvedValueOnce([runtime(false)])
    const first = useRuntimes.getState().load()
    await useRuntimes.getState().load()
    resolve([runtime(true)])
    await first
    expect(useRuntimes.getState().runtimes?.[0].profile.enabled).toBe(false)
  })
  it('refreshes external runtime configuration changes from other windows', async () => {
    wireRuntimeEvents()
    call.mockResolvedValue([runtime(true)])
    const refresh = on.mock.calls.find(([method]) => method === 'runtimes.changed')?.[1]
    refresh!()
    await vi.waitFor(() => expect(useRuntimes.getState().runtimes?.[0].profile.enabled).toBe(true))
  })
  it('creates and sends external conversations with no configured Navo model', async () => {
    call.mockResolvedValue(thread)
    await useChat.getState().newThread('navo-model', null, 'pi')
    expect(call).toHaveBeenCalledWith('threads.create', 'navo-model', null, 'pi')
    call.mockClear()
    await useChat.getState().sendTo('thread', 'hello')
    expect(call).toHaveBeenCalledWith('chat.send', 'thread', 'hello', undefined, undefined)
    expect(call).not.toHaveBeenCalledWith('models.list')
  })
  it('does not regenerate or drop messages for an engine without fork support', async () => {
    useChat.getState().handle({ type: 'message', threadId: 'thread', message: { id: 'user', role: 'user', content: 'hello' } })
    useChat.getState().handle({ type: 'message', threadId: 'thread', message: { id: 'assistant', role: 'assistant', content: 'answer' } })
    await useChat.getState().regenerate('user')
    expect(call).not.toHaveBeenCalled()
    expect(useChat.getState().views.thread.messages).toHaveLength(2)
  })
})
