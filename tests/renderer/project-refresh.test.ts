import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { call, listeners } = vi.hoisted(() => ({ call: vi.fn(), listeners: new Map<string, (() => void)[]>() }))
vi.mock('@/lib/ipc', () => ({
  call,
  on: (event: string, callback: () => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), callback])
    return () => {}
  },
}))
vi.mock('@/lib/utils', () => ({ errorMessage: (e: Error) => e.message }))
import { useProjects, wireProjectEvents } from '@/stores/projects'
import { useArtifacts, wireArtifactEvents } from '@/stores/artifacts'
const emit = (event: string) => listeners.get(event)?.forEach((fn) => fn())
wireProjectEvents()
wireArtifactEvents()
beforeEach(() => {
  vi.useFakeTimers()
  call.mockReset().mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

it('coalesces the events from a write into one request per visible store', async () => {
  const unwatch = useArtifacts.getState().watch({ projectId: 'project' })
  const revision = useProjects.getState().revision
  try {
    emit('projects.changed')
    emit('threads.changed')
    emit('artifacts.changed')
    emit('outputs.changed')
    emit('outputs.changed')
    expect(call).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(call.mock.calls).toEqual([['projects.list'], ['artifacts.list', 'project']])
    expect(useProjects.getState().revision).toBe(revision + 1)
  } finally {
    unwatch()
  }
})

it('an explicit project reload consumes a pending refresh without a second request', async () => {
  const revision = useProjects.getState().revision
  emit('projects.changed')
  await useProjects.getState().load()
  await vi.advanceTimersByTimeAsync(100)
  expect(call).toHaveBeenCalledTimes(1)
  expect(useProjects.getState().revision).toBe(revision + 1)
})

it('ignores stale project results after a newer refresh succeeds', async () => {
  let resolve!: (value: unknown[]) => void
  call
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    .mockResolvedValueOnce([{ id: 'fresh' }])
  const old = useProjects.getState().load()
  emit('projects.changed')
  await vi.advanceTimersByTimeAsync(50)
  resolve([{ id: 'stale' }])
  await old
  expect(useProjects.getState().projects).toEqual([{ id: 'fresh' }])
})
