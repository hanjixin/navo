import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../src/shared/types'
const mocks = vi.hoisted(() => ({ db: vi.fn(), emit: vi.fn(), notify: vi.fn() }))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return true
    }
    show = mocks.notify
  },
}))
vi.mock('../src/main/browser/browser-service', () => ({ browser: {} }))
vi.mock('../src/main/core/db', () => ({ db: mocks.db, json: { parse: JSON.parse, str: JSON.stringify } }))
vi.mock('../src/main/core/ipc', () => ({ emit: mocks.emit }))
vi.mock('../src/main/core/logger', () => ({ log: { warn: vi.fn() } }))
vi.mock('../src/main/usage/usage-service', () => ({ trackedModel: vi.fn() }))
import { monitor } from '../src/main/monitor/monitor-service'
const task = { id: 'monitor', name: 'Monitor', kind: 'monitor', monitor: { url: 'https://example.org', action: 'notify' } } as Task
beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
describe('monitor cancellation', () => {
  it('does not change baseline, failure streak, notifications or history after cancellation', async () => {
    const controller = new AbortController()
    vi.spyOn(monitor, 'read').mockImplementationOnce(async () => {
      controller.abort()
      return { text: 'changed', title: 'Page' }
    })
    await expect(monitor.check(task, undefined, controller.signal)).rejects.toThrow()
    expect(mocks.db).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.emit).not.toHaveBeenCalled()
  })
  it('releases the monitor lock after cancellation', async () => {
    const read = vi.spyOn(monitor, 'read').mockRejectedValue(new Error('cancelled'))
    const first = new AbortController()
    first.abort()
    const second = new AbortController()
    second.abort()
    await expect(monitor.check(task, undefined, first.signal)).rejects.toThrow()
    await expect(monitor.check(task, undefined, second.signal)).rejects.not.toThrow('上一次检查还没有结束')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
