import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatDraft, DraftScope, DraftSaveInput } from '@shared/reliability'

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/lib/ipc', () => ({ call, on: vi.fn(() => () => {}) }))
vi.mock('@/lib/utils', () => ({ errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))
import { useDrafts, draftKey, submitDraft } from '@/stores/drafts'

const database = new Map<string, ChatDraft>()
const scope = (id: string): DraftScope => ({ surface: 'main', threadId: id })
const blank = (s: DraftScope): ChatDraft => ({ scope: s, text: '', modelId: null, fileIds: [], projectFiles: [], version: 0, updatedAt: 0 })
function stored(s: DraftScope) {
  return structuredClone(database.get(draftKey(s)) ?? blank(s))
}
function backend(method: string, input: unknown): unknown {
  if (method === 'drafts.get') return stored(input as DraftScope)
  if (method === 'drafts.save') {
    const draft = input as DraftSaveInput,
      previous = stored(draft.scope)
    if (draft.expectedVersion !== previous.version) throw new Error('Draft changed; reload before saving')
    const next = { ...draft, version: previous.version + 1, updatedAt: Date.now() }
    database.set(draftKey(draft.scope), next)
    return next
  }
  throw new Error(`Unexpected ${method}`)
}
beforeEach(() => {
  vi.useFakeTimers()
  database.clear()
  useDrafts.setState({ entries: {} })
  call.mockReset().mockImplementation((method, input) => Promise.resolve(backend(method, input)))
})
afterEach(async () => {
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('persistent renderer drafts', () => {
  it('keeps text and delayed attachments scoped to their original context', async () => {
    const a = scope('a'),
      b = scope('b')
    await useDrafts.getState().load(a)
    useDrafts.getState().patch(a, { text: 'draft A', modelId: 'model-a' })
    await useDrafts.getState().load(b)
    useDrafts.getState().patch(b, { text: 'draft B' })
    await useDrafts.getState().addFiles(a, ['file-a'])
    await useDrafts.getState().flush(b)
    expect(stored(a)).toMatchObject({ text: 'draft A', fileIds: ['file-a'], modelId: 'model-a' })
    expect(stored(b)).toMatchObject({ text: 'draft B', fileIds: [] })
  })

  it('does not lose local edits when saving fails and a retry reloads metadata', async () => {
    const s = scope('save-error')
    await useDrafts.getState().load(s)
    useDrafts.getState().patch(s, { text: 'keep this' })
    call.mockRejectedValueOnce(new Error('offline'))
    await expect(useDrafts.getState().flush(s)).rejects.toThrow('offline')
    expect(useDrafts.getState().entries[draftKey(s)].data.text).toBe('keep this')
    await useDrafts.getState().flush(s)
    expect(stored(s).text).toBe('keep this')
  })

  it('preserves edits made after submission started when its receipt arrives', async () => {
    const s = scope('late-receipt')
    await useDrafts.getState().load(s)
    useDrafts.getState().patch(s, { text: 'first message' })
    let resolve!: (value: unknown) => void
    call.mockImplementation((method, input) =>
      method === 'chat.submit'
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve(backend(method, input)),
    )
    const pending = submitDraft(s, { threadId: s.threadId })
    await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'chat.submit')).toBe(true))
    useDrafts.getState().patch(s, { text: 'next message' })
    await useDrafts.getState().flush(s)
    resolve({ requestId: 'r', threadId: s.threadId, messageId: 'm', executionId: 'e' })
    await pending
    expect(useDrafts.getState().entries[draftKey(s)].data.text).toBe('next message')
    expect(stored(s).text).toBe('next message')
  })

  it('reuses the complete original request after an acknowledgement is lost', async () => {
    const s = scope('ack-lost')
    await useDrafts.getState().load(s)
    useDrafts.getState().patch(s, { text: 'send exactly once' })
    let attempt = 0
    call.mockImplementation((method, input) => {
      if (method !== 'chat.submit') return Promise.resolve(backend(method, input))
      if (!attempt++) {
        const old = stored(s)
        database.set(draftKey(s), { ...blank(s), version: old.version + 1 })
        return Promise.reject(new Error('lost ACK'))
      }
      return Promise.resolve({ requestId: 'r', threadId: s.threadId, messageId: 'm', executionId: 'e' })
    })
    await expect(submitDraft(s, { threadId: s.threadId })).rejects.toThrow('lost ACK')
    await submitDraft(s, { threadId: s.threadId })
    const submissions = call.mock.calls.filter(([method]) => method === 'chat.submit')
    expect(submissions[1][1]).toEqual(submissions[0][1])
    expect(useDrafts.getState().entries[draftKey(s)].data.text).toBe('')
  })

  it('does not overwrite a server-cleared draft when an old save conflicts', async () => {
    const s = scope('cleared')
    await useDrafts.getState().load(s)
    useDrafts.getState().patch(s, { text: 'old text' })
    database.set(draftKey(s), { ...blank(s), version: 2 })
    await expect(useDrafts.getState().flush(s)).rejects.toThrow('Draft changed')
    expect(stored(s).text).toBe('')
    expect(useDrafts.getState().entries[draftKey(s)].data.text).toBe('old text')
  })
})

describe('runtime draft isolation', () => {
  it('persists selected runtime and submits it without a Navo model', async () => {
    const s: DraftScope = { surface: 'main', projectId: 'runtime-project' }
    await useDrafts.getState().load(s)
    useDrafts.getState().patch(s, { text: 'external question', runtimeId: 'pi', modelId: null })
    await useDrafts.getState().flush(s)
    expect(stored(s).runtimeId).toBe('pi')
    call.mockImplementation((method, input) => (method === 'chat.submit' ? Promise.resolve({ threadId: 'external' }) : Promise.resolve(backend(method, input))))
    await submitDraft(s)
    expect(call.mock.calls.find(([method]) => method === 'chat.submit')?.[1]).toMatchObject({ runtimeId: 'pi', modelId: null })
  })
  it('keeps a newly selected runtime when an earlier submission receipt arrives', async () => {
    const s: DraftScope = { surface: 'main', projectId: 'late-runtime-project' }
    await useDrafts.getState().load(s)
    useDrafts.getState().patch(s, { text: 'first', runtimeId: 'pi' })
    let done!: (receipt: unknown) => void
    call.mockImplementation((method, input) =>
      method === 'chat.submit'
        ? new Promise((resolve) => {
            done = resolve
          })
        : Promise.resolve(backend(method, input)),
    )
    const pending = submitDraft(s)
    await vi.waitFor(() => expect(done).toBeTypeOf('function'))
    useDrafts.getState().patch(s, { text: 'next', runtimeId: 'codex' })
    done({ threadId: 'external' })
    await pending
    expect(useDrafts.getState().entries[draftKey(s)].data).toMatchObject({ runtimeId: 'codex', text: 'next' })
  })
})
