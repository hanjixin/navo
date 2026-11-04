import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptWorkspaceWrite } from '../src/main/outputs/workspace-write'
import { CompositeBackend, StateBackend } from 'deepagents'
import { WorkspaceBackend } from '../src/main/agent-host/workspace-backend'

const dirs: string[] = []
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'navo-ownership-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('workspace mutation attribution', () => {
  it('reports successful write and edit, but never failed write or edit', async () => {
    const report = vi.fn(async (_path: string) => {})
    const backend = new WorkspaceBackend(workspace(), report)
    expect((await backend.write('/report.txt', 'original')).error).toBeUndefined()
    expect((await backend.write('/../outside.txt', 'invalid')).error).toBeTruthy()
    expect((await backend.edit('/report.txt', 'absent', 'replacement')).error).toBeTruthy()
    expect((await backend.edit('/report.txt', 'original', 'updated')).error).toBeUndefined()
    expect(report.mock.calls.map((c) => c[0])).toEqual(['/report.txt', '/report.txt'])
  })
  it('reports only successfully uploaded files', async () => {
    const reported: string[] = []
    const backend = new WorkspaceBackend(workspace(), async (path) => {
      reported.push(path)
    })
    const results = await backend.uploadFiles([
      ['/ok.txt', new TextEncoder().encode('ok')],
      ['/../outside.txt', new Uint8Array()],
    ])
    expect(results[0].error).toBeNull()
    expect(results[1].error).toBeTruthy()
    expect(reported).toEqual(['/ok.txt'])
  })
  it('keeps concurrent writers attributed to their own thread in a shared workspace', async () => {
    const root = workspace()
    const events: { threadId: string; path: string }[] = []
    const a = new WorkspaceBackend(root, async (path) => {
      events.push({ threadId: 'a', path })
    })
    const b = new WorkspaceBackend(root, async (path) => {
      events.push({ threadId: 'b', path })
    })
    await Promise.all([a.write('/a.txt', 'A'), b.write('/b.txt', 'B')])
    expect(events).toHaveLength(2)
    expect(events).toContainEqual({ threadId: 'a', path: '/a.txt' })
    expect(events).toContainEqual({ threadId: 'b', path: '/b.txt' })
    await a.edit('/b.txt', 'B', 'changed by A')
    expect(events.at(-1)).toEqual({ threadId: 'a', path: '/b.txt' })
  })
})

describe('main-process run validation', () => {
  it('accepts active concurrent runs and rejects stale, swapped, or finished run IDs', async () => {
    const runs = new Map([
      ['a', { runId: 'run-a' }],
      ['b', { runId: 'run-b' }],
    ])
    const records: { threadId: string; path: string }[] = []
    const report = (event: { threadId: string; runId: string; path: string }) =>
      acceptWorkspaceWrite(event, runs, (threadId, path) => records.push({ threadId, path }))
    const root = workspace()
    const a = new WorkspaceBackend(root, async (path) => report({ threadId: 'a', runId: 'run-a', path }))
    const b = new WorkspaceBackend(root, async (path) => report({ threadId: 'b', runId: 'run-b', path }))
    await Promise.all([a.write('/a.txt', 'A'), b.write('/b.txt', 'B')])
    report({ threadId: 'a', runId: 'run-b', path: '/b.txt' })
    runs.set('a', { runId: 'next-run' })
    await a.edit('/a.txt', 'A', 'late mutation')
    runs.delete('b')
    await b.edit('/b.txt', 'B', 'finished mutation')
    expect(records).toHaveLength(2)
    expect(records).toContainEqual({ threadId: 'a', path: '/a.txt' })
    expect(records).toContainEqual({ threadId: 'b', path: '/b.txt' })
  })
})

it('receives workspace-relative paths from the real CompositeBackend mount', async () => {
  const reported: string[] = []
  const backend = new CompositeBackend(new StateBackend(), {
    '/workspace/': new WorkspaceBackend(workspace(), async (path) => {
      reported.push(path)
    }),
  })
  await backend.write('/workspace/nested/file.txt', 'first')
  await backend.edit('/workspace/nested/file.txt', 'first', 'second')
  await backend.uploadFiles([['/workspace/upload.txt', new Uint8Array([65])]])
  expect(reported).toEqual(['/nested/file.txt', '/nested/file.txt', '/upload.txt'])
})
