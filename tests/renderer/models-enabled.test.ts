import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelConfig, Thread } from '@shared/types'

const { call, on } = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn<(method: string, listener: () => void) => () => void>(() => () => {}) }))
vi.mock('@/lib/ipc', () => ({ call, on }))
vi.mock('@/lib/utils', () => ({ errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }))
vi.mock('@shared/i18n', () => ({ t: (text: string) => text }))
import { useModels, wireModelEvents } from '@/stores/models'
import { useChat } from '@/stores/chat'

const model = (id: string, enabled: boolean): ModelConfig => ({
  id,
  enabled,
  providerId: 'provider',
  model: id,
  displayName: id,
  supportsTools: true,
  supportsVision: false,
  isDefault: enabled,
  pricing: null,
})
const thread = { id: 'thread', modelId: 'off' } as Thread
beforeEach(() => {
  call.mockReset()
  useModels.setState({ models: undefined, activeModels: undefined, providers: undefined, error: null })
  useChat.setState({ threads: [thread], activeId: 'thread', views: {} })
})

describe('enabled model selection', () => {
  it('retains every configuration while excluding disabled models from usage', async () => {
    const models = [model('on', true), model('off', false)]
    call.mockImplementation((method) => Promise.resolve(method === 'models.list' ? models : []))
    await useModels.getState().load()
    expect(useModels.getState().models).toEqual(models)
    expect(useModels.getState().activeModels?.map((item) => item.id)).toEqual(['on'])
  })

  it('ignores an old response that would make a disabled model available again', async () => {
    let resolve!: (models: ModelConfig[]) => void
    const old = new Promise<ModelConfig[]>((done) => {
      resolve = done
    })
    let reads = 0
    call.mockImplementation((method) => (method !== 'models.list' ? Promise.resolve([]) : ++reads === 1 ? old : Promise.resolve([model('off', false)])))
    const first = useModels.getState().load()
    await useModels.getState().load()
    resolve([model('off', true)])
    await first
    expect(useModels.getState().activeModels).toEqual([])
  })

  it('refreshes the model list on changes from another window', async () => {
    wireModelEvents()
    const callback = on.mock.calls.find((args) => args[0] === 'models.changed')?.[1] as (() => void) | undefined
    expect(callback).toBeTypeOf('function')
    call.mockImplementation((method) => Promise.resolve(method === 'models.list' ? [model('new', true)] : []))
    callback!()
    await vi.waitFor(() => expect(useModels.getState().activeModels?.[0]?.id).toBe('new'))
  })

  it('blocks send for a disabled conversation model without silently choosing another model', async () => {
    useModels.setState({ models: [model('off', false), model('on', true)], activeModels: [model('on', true)] })
    await useChat.getState().sendTo('thread', 'hello')
    expect(call).not.toHaveBeenCalled()
    expect(useChat.getState().views.thread.error).toContain('当前模型已停用')
    expect(useChat.getState().views.thread.running).toBe(false)
  })

  it('blocks regeneration before dropping the existing conversation branch', async () => {
    useModels.setState({ models: [model('off', false)], activeModels: [] })
    useChat.getState().handle({ type: 'message', threadId: 'thread', message: { id: 'user', role: 'user', content: 'hello' } })
    useChat.getState().handle({ type: 'message', threadId: 'thread', message: { id: 'answer', role: 'assistant', content: 'existing answer' } })
    await useChat.getState().regenerate('user')
    expect(call).not.toHaveBeenCalled()
    expect(useChat.getState().views.thread.messages.map((message) => message.id)).toEqual(['user', 'answer'])
  })

  it('rejects creating a conversation with an explicitly disabled model', async () => {
    useModels.setState({ models: [model('off', false)], activeModels: [] })
    await expect(useChat.getState().newThread('off')).rejects.toThrow('当前模型已停用')
    expect(call).not.toHaveBeenCalled()
  })

  it('blocks sends when all models are disabled and permits an explicitly enabled replacement', async () => {
    useModels.setState({ models: [model('off', false)], activeModels: [] })
    useChat.setState({ threads: [{ ...thread, modelId: null }] })
    await useChat.getState().sendTo('thread', 'hello')
    expect(call).not.toHaveBeenCalled()
    expect(useChat.getState().views.thread.error).toContain('没有已启用')
    useModels.setState({ activeModels: [model('on', true)] })
    useChat.setState({ threads: [{ ...thread, modelId: 'on' }] })
    call.mockResolvedValue(undefined)
    await useChat.getState().sendTo('thread', 'hello')
    expect(call).toHaveBeenCalledWith('chat.send', 'thread', 'hello', undefined, undefined)
  })
})
