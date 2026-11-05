import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Macro } from '../src/shared/types'
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  replay: vi.fn(),
  save: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  state: vi.fn(),
  db: vi.fn(),
  listener: null as null | ((event: { threadId: string; phase: string }) => void),
}))
vi.mock('../src/main/agent/agent-service', () => ({
  agent: {
    createThread: mocks.create,
    send_: mocks.send,
    stop: mocks.stop,
    threadState: mocks.state,
    subscribeExecution: (listener: typeof mocks.listener) => {
      mocks.listener = listener
      return vi.fn()
    },
  },
}))
vi.mock('../src/main/browser/agent-session', () => ({ sessions: { assign: vi.fn() } }))
vi.mock('../src/main/browser/browser-service', () => ({
  browser: { newTab: () => 9, tab: () => ({ isDestroyed: () => false, getTitle: () => 'Page', getURL: () => 'https://example.org' }), closeTab: mocks.close },
}))
vi.mock('../src/main/core/db', () => ({ db: mocks.db, json: { parse: JSON.parse } }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/logger', () => ({ log: { warn: vi.fn() } }))
vi.mock('../src/main/usage/usage-service', () => ({ trackedModel: vi.fn() }))
vi.mock('../src/main/recorder/recorder-service', () => ({ recorder: { get: mocks.get, run: mocks.replay, save: mocks.save } }))
import { flows } from '../src/main/flows/flows'
const macro: Macro = {
  id: 'flow',
  name: 'Flow',
  description: '',
  exposeAsTool: false,
  params: [],
  steps: [{ id: 'click', type: 'click', selectors: ['button'] }],
  createdAt: 1,
  updatedAt: 1,
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockReturnValue(macro)
  mocks.create.mockReturnValue({ id: 'repair' })
  mocks.replay.mockResolvedValue({ ok: false, failedStep: 0, error: 'Missing button', extracted: {} })
})
describe('flow repair cancellation', () => {
  it('never starts repair when replay reports cancellation', async () => {
    mocks.replay.mockResolvedValueOnce({ ok: false, aborted: true, extracted: {} })
    expect(await flows.run('flow', {}, true)).toMatchObject({ aborted: true })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledWith(9)
  })
  it('binds the repair before send and does not save a repair after cancellation', async () => {
    const controller = new AbortController()
    const bound = vi.fn()
    mocks.send.mockImplementationOnce(async () => {
      expect(bound).toHaveBeenCalledWith('repair')
      controller.abort()
      return { finalText: 'Done' }
    })
    const result = await flows.run('flow', {}, true, { signal: controller.signal, onRepairThread: bound, modelId: 'chosen' })
    expect(result.aborted).toBe(true)
    expect(mocks.create).toHaveBeenCalledWith('chosen', expect.anything())
    expect(mocks.stop).toHaveBeenCalledWith('repair')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.db).not.toHaveBeenCalled()
  })
  it('keeps a waiting repair tab until approval execution finishes and never writes an incomplete version', async () => {
    mocks.send.mockResolvedValueOnce({ interrupted: true, finalText: '' })
    expect(await flows.run('flow', {}, true)).toMatchObject({ interrupted: true, repairThreadId: 'repair' })
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    mocks.listener!({ threadId: 'other', phase: 'success' })
    expect(mocks.close).not.toHaveBeenCalled()
    mocks.listener!({ threadId: 'repair', phase: 'cancelled' })
    expect(mocks.close).toHaveBeenCalledWith(9)
  })
})
