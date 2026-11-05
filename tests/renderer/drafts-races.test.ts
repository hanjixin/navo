import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatDraft, ChatSubmitInput, DraftSaveInput, DraftScope } from '@shared/reliability'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  flushDraft: vi.fn(),
  changes: new Map<string, (scope: DraftScope) => void>(),
  windowEvents: new Map<string, (event: { preventDefault(): void; returnValue: string }) => void>(),
}))
vi.mock('@/lib/ipc', () => ({
  call: mocks.call,
  on: (name: string, listener: (scope: DraftScope) => void) => {
    mocks.changes.set(name, listener)
    return () => mocks.changes.delete(name)
  },
}))
vi.mock('@/lib/utils', () => ({ errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }))
import { draftKey, submitDraft, useDrafts, wireDraftEvents } from '@/stores/drafts'

const database = new Map<string, ChatDraft>()
const scope = (id: string, surface: 'main' | 'quick' = 'main'): DraftScope => ({ surface, threadId: id })
const blank = (scope: DraftScope, version = 0): ChatDraft => ({ scope, text: '', fileIds: [], projectFiles: [], modelId: null, version, updatedAt: 0 })
const stored = (scope: DraftScope) => structuredClone(database.get(draftKey(scope)) ?? blank(scope))
function backend(method: string, input: unknown): unknown {
  if (method === 'drafts.get') return stored(input as DraftScope)
  if (method === 'drafts.save') {
    const draft = input as DraftSaveInput
    const previous = stored(draft.scope)
    if (draft.expectedVersion !== previous.version) throw new Error('Draft changed; reload before saving')
    const next = { ...draft, version: previous.version + 1, updatedAt: Date.now() }
    database.set(draftKey(draft.scope), next)
    return next
  }
  throw new Error(`Unexpected ${method}`)
}
const receipt = (input: ChatSubmitInput) => ({
  requestId: input.requestId,
  threadId: input.threadId,
  messageId: `message-${input.requestId}`,
  executionId: `execution-${input.requestId}`,
})

beforeAll(() => {
  vi.stubGlobal('window', {
    api: { flushDraft: mocks.flushDraft },
    addEventListener: (name: string, listener: (event: { preventDefault(): void; returnValue: string }) => void) => mocks.windowEvents.set(name, listener),
  })
  wireDraftEvents()
})
beforeEach(() => {
  vi.useFakeTimers()
  database.clear()
  useDrafts.setState({ entries: {} })
  mocks.flushDraft.mockReset()
  mocks.call.mockReset().mockImplementation(async (method, input) => backend(method, input))
})
afterEach(async () => {
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})
afterAll(() => vi.unstubAllGlobals())

describe('draft response ordering and shutdown', () => {
  it('preserves and persists text entered while a quick-to-main transfer is awaiting its response', async () => {
    const source = scope('late-transfer', 'quick'),
      target = scope('late-transfer')
    await useDrafts.getState().load(source)
    useDrafts.getState().patch(source, { text: 'move this' })
    await useDrafts.getState().flush(source)
    let finish!: (result: { moved: boolean; draft: ChatDraft }) => void
    mocks.call.mockImplementation((method, input) =>
      method === 'drafts.move'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(backend(method, input)),
    )
    const transferring = useDrafts.getState().transfer(source, target)
    await vi.waitFor(() => expect(finish).toBeDefined())
    useDrafts.getState().patch(source, { text: 'typed after transfer began' })
    database.set(draftKey(source), blank(source, 2))
    database.set(draftKey(target), { ...blank(target, 1), text: 'move this' })
    finish({ moved: true, draft: stored(target) })
    expect(await transferring).toBe(true)
    expect(useDrafts.getState().entries[draftKey(source)].data.text).toBe('typed after transfer began')
    expect(stored(source).text).toBe('typed after transfer began')
    expect(stored(target).text).toBe('move this')
  })

  it('ignores an older event response that arrives after a newer server version', async () => {
    const target = scope('event-order')
    await useDrafts.getState().load(target)
    const responses: ((value: ChatDraft) => void)[] = []
    mocks.call.mockImplementation(() => new Promise((resolve) => responses.push(resolve)))
    mocks.changes.get('drafts.changed')!(target)
    mocks.changes.get('drafts.changed')!(target)
    responses[1]({ ...blank(target, 2), text: 'latest' })
    await Promise.resolve()
    responses[0]({ ...blank(target, 1), text: 'stale' })
    await Promise.resolve()
    expect(useDrafts.getState().entries[draftKey(target)].data).toMatchObject({ text: 'latest', version: 2 })
  })

  it('never rebases old content over a server clear when retrying a CAS conflict', async () => {
    const target = scope('clear-conflict')
    await useDrafts.getState().load(target)
    useDrafts.getState().patch(target, { text: 'already submitted' })
    database.set(draftKey(target), blank(target, 2))
    await expect(useDrafts.getState().flush(target)).rejects.toThrow('Draft changed')
    await expect(useDrafts.getState().flush(target)).rejects.toThrow('Draft changed')
    expect(stored(target)).toMatchObject({ text: '', version: 2 })
    expect(useDrafts.getState().entries[draftKey(target)].data.text).toBe('already submitted')
  })

  it('takes the payload and revision from the same flushed snapshot when input arrives between promises', async () => {
    const target = scope('snapshot-gap')
    await useDrafts.getState().load(target)
    useDrafts.getState().patch(target, { text: 'original' })
    const originalFlush = useDrafts.getState().flush
    let injected = false
    useDrafts.setState({
      flush: async (currentScope) => {
        const data = await originalFlush(currentScope)
        if (!injected) {
          injected = true
          queueMicrotask(() => useDrafts.getState().patch(currentScope, { text: 'latest before submission' }))
        }
        return data
      },
    })
    mocks.call.mockImplementation(async (method, input) => {
      if (method !== 'chat.submit') return backend(method, input)
      const request = input as ChatSubmitInput
      database.set(draftKey(target), blank(target, stored(target).version + 1))
      return receipt(request)
    })
    try {
      await submitDraft(target, { threadId: target.threadId })
      expect(mocks.call.mock.calls.find(([method]) => method === 'chat.submit')?.[1]).toMatchObject({ text: 'latest before submission' })
      expect(useDrafts.getState().entries[draftKey(target)].data.text).toBe('')
    } finally {
      useDrafts.setState({ flush: originalFlush })
    }
  })

  it('does not lose a newer edit arriving between the transfer flush and its version snapshot', async () => {
    const source = scope('transfer-snapshot-gap', 'quick'),
      target = scope('transfer-snapshot-gap')
    await useDrafts.getState().load(source)
    useDrafts.getState().patch(source, { text: 'original before move' })
    const originalFlush = useDrafts.getState().flush
    let injected = false
    useDrafts.setState({
      flush: async (currentScope) => {
        const data = await originalFlush(currentScope)
        if (!injected) {
          injected = true
          queueMicrotask(() => useDrafts.getState().patch(currentScope, { text: 'latest before move' }))
        }
        return data
      },
    })
    mocks.call.mockImplementation(async (method, input) => {
      if (method !== 'drafts.move') return backend(method, input)
      const from = stored(source)
      database.set(draftKey(target), { ...from, scope: target, version: 1 })
      database.set(draftKey(source), blank(source, from.version + 1))
      return { moved: true, draft: stored(target) }
    })
    try {
      expect(await useDrafts.getState().transfer(source, target)).toBe(true)
      expect([stored(source).text, stored(target).text]).toContain('latest before move')
    } finally {
      useDrafts.setState({ flush: originalFlush })
    }
  })

  it('prevents closing when the final synchronous draft write fails', async () => {
    const target = scope('closing')
    await useDrafts.getState().load(target)
    useDrafts.getState().patch(target, { text: 'must survive' })
    mocks.flushDraft.mockImplementation(() => {
      throw new Error('Disk unavailable')
    })
    const event = { preventDefault: vi.fn(), returnValue: 'unchanged' }
    mocks.windowEvents.get('beforeunload')!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe('')
    expect(useDrafts.getState().entries[draftKey(target)]).toMatchObject({ data: { text: 'must survive' }, error: 'Disk unavailable' })
  })

  it('does not let an old acknowledgement remove the retry identity of a newer submission', async () => {
    const target = scope('overlapping-receipts')
    await useDrafts.getState().load(target)
    useDrafts.getState().patch(target, { text: 'first' })
    let firstRequest: ChatSubmitInput | null = null
    let finishFirst!: (result: ReturnType<typeof receipt>) => void
    let secondAttempts = 0
    mocks.call.mockImplementation((method, input) => {
      if (method !== 'chat.submit') return Promise.resolve(backend(method, input))
      const request = input as ChatSubmitInput
      if (request.text === 'first') {
        firstRequest = request
        return new Promise((resolve) => {
          finishFirst = resolve
        })
      }
      if (!secondAttempts++) {
        database.set(draftKey(target), blank(target, stored(target).version + 1))
        return Promise.reject(new Error('Second ACK lost'))
      }
      return Promise.resolve(receipt(request))
    })
    const first = submitDraft(target, { threadId: target.threadId })
    await vi.waitFor(() => expect(firstRequest).not.toBeNull())
    useDrafts.getState().patch(target, { text: 'second' })
    await expect(submitDraft(target, { threadId: target.threadId })).rejects.toThrow('Second ACK lost')
    finishFirst(receipt(firstRequest!))
    await first
    await submitDraft(target, { threadId: target.threadId })
    const secondCalls = mocks.call.mock.calls.filter(([method, input]) => method === 'chat.submit' && (input as ChatSubmitInput).text === 'second')
    expect(secondCalls).toHaveLength(2)
    expect(secondCalls[1][1]).toEqual(secondCalls[0][1])
  })
})
