import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from '@shared/types'

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/lib/ipc', () => ({ call, on: vi.fn(() => () => {}) }))
vi.mock('@/lib/utils', () => ({ errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }))
import { artifactScopeKey, useArtifacts } from '@/stores/artifacts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const artifact = (id: string, projectId: string | null = null, threadId = `thread-${id}`): Artifact => ({
  id,
  projectId,
  threadId,
  projectName: projectId,
  threadTitle: threadId,
  name: `${id}.md`,
  path: `/workspace/${id}.md`,
  source: 'agent',
  kind: 'markdown',
  size: 10,
  at: 1,
  missing: false,
  exports: [],
})
const query = (projectId?: string | null, threadId?: string) => useArtifacts.getState().queries[artifactScopeKey({ projectId, threadId })]

beforeEach(() => {
  useArtifacts.getState().refresh()
  call.mockReset()
})

describe('artifact scope state', () => {
  it('isolates all, unassigned, project and thread lists', async () => {
    const a = artifact('a', 'p1', 't1')
    const b = artifact('b', 'p2', 't2')
    const c = artifact('c')
    call.mockResolvedValueOnce([a, b, c]).mockResolvedValueOnce([c]).mockResolvedValueOnce([a]).mockResolvedValueOnce([a, b, c])
    await useArtifacts.getState().load()
    await useArtifacts.getState().load({ projectId: null })
    await useArtifacts.getState().load({ projectId: 'p1' })
    await useArtifacts.getState().load({ threadId: 't2' })
    expect(query()?.items).toEqual([a, b, c])
    expect(query(null)?.items).toEqual([c])
    expect(query('p1')?.items).toEqual([a])
    expect(query(undefined, 't2')?.items).toEqual([b])
    expect(Object.keys(useArtifacts.getState().queries)).toHaveLength(4)
    expect(call.mock.calls).toEqual([
      ['artifacts.list', undefined],
      ['artifacts.list', null],
      ['artifacts.list', 'p1'],
      ['artifacts.list', undefined],
    ])
  })

  it('ignores an older result that finishes after the latest request for the same scope', async () => {
    const old = deferred<Artifact[]>()
    const latest = deferred<Artifact[]>()
    call.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const first = useArtifacts.getState().load({ projectId: 'p' })
    const second = useArtifacts.getState().load({ projectId: 'p' })
    latest.resolve([artifact('latest', 'p')])
    await second
    old.resolve([artifact('old', 'p')])
    await first
    expect(query('p')).toEqual({ items: [artifact('latest', 'p')], loading: false, error: null })
  })

  it('does not replace a successful newer response with an older rejection', async () => {
    const old = deferred<Artifact[]>()
    call.mockReturnValueOnce(old.promise).mockResolvedValueOnce([artifact('latest')])
    const first = useArtifacts.getState().load()
    await useArtifacts.getState().load()
    old.reject(new Error('stale failure'))
    await first
    expect(query()?.error).toBeNull()
    expect(query()?.items?.[0].id).toBe('latest')
  })

  it('shows no previous project items when a new project request fails', async () => {
    call.mockResolvedValueOnce([artifact('a', 'a')]).mockRejectedValueOnce(new Error('offline'))
    await useArtifacts.getState().load({ projectId: 'a' })
    await useArtifacts.getState().load({ projectId: 'b' })
    expect(query('a')?.items).toEqual([artifact('a', 'a')])
    expect(query('b')).toEqual({ items: undefined, loading: false, error: 'offline' })
  })

  it('refresh invalidates in-flight results for scopes without visible consumers', async () => {
    const pending = deferred<Artifact[]>()
    call.mockReturnValueOnce(pending.promise)
    const load = useArtifacts.getState().load({ projectId: 'p' })
    useArtifacts.getState().refresh()
    pending.resolve([artifact('stale', 'p')])
    await load
    expect(useArtifacts.getState().queries).toEqual({})
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('refresh reloads a watched scope once and discards its pre-refresh request', async () => {
    const old = deferred<Artifact[]>()
    const fresh = deferred<Artifact[]>()
    const scope = { projectId: 'p' }
    const unwatch1 = useArtifacts.getState().watch(scope)
    const unwatch2 = useArtifacts.getState().watch(scope)
    try {
      call.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      const first = useArtifacts.getState().load(scope)
      useArtifacts.getState().refresh()
      expect(call).toHaveBeenCalledTimes(2)
      fresh.resolve([artifact('fresh', 'p')])
      await fresh.promise
      old.resolve([artifact('stale', 'p')])
      await first
      expect(query('p')).toEqual({ items: [artifact('fresh', 'p')], loading: false, error: null })
      unwatch1()
      call.mockResolvedValue([])
      useArtifacts.getState().refresh()
      expect(call).toHaveBeenCalledTimes(3)
      await Promise.resolve()
    } finally {
      unwatch2()
    }
    useArtifacts.getState().refresh()
    expect(call).toHaveBeenCalledTimes(3)
  })
})
