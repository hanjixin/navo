import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Task } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  db: null as unknown as DatabaseSync,
  listener: null as null | ((event: { threadId: string; executionId: string; phase: string; result?: { finalText: string } }) => void),
  send: vi.fn(),
  create: vi.fn(),
  stop: vi.fn(),
  flow: vi.fn(),
  check: vi.fn(),
  notify: vi.fn(),
  state: vi.fn(),
  model: vi.fn(),
}))
vi.mock('../src/main/core/db', () => ({
  db: () => ({
    prepare: (sql: string) => {
      const statement = mocks.db.prepare(sql)
      statement.setAllowUnknownNamedParameters(true)
      return statement
    },
  }),
  json: { parse: (value: string | null) => (value ? JSON.parse(value) : null), str: JSON.stringify },
}))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return true
    }
    show = mocks.notify
  },
}))
vi.mock('node-cron', () => ({ default: { validate: () => true, schedule: () => ({ stop: vi.fn() }) } }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('../src/main/agent/agent-service', () => ({
  agent: {
    createThread: mocks.create,
    send_: mocks.send,
    stop: mocks.stop,
    threadState: mocks.state,
    executionId: () => 'restored',
    subscribeExecution: (listener: typeof mocks.listener) => {
      mocks.listener = listener
      return () => {}
    },
  },
}))
vi.mock('../src/main/flows/flows', () => ({ flows: { run: mocks.flow } }))
vi.mock('../src/main/monitor/monitor-service', () => ({ monitor: { check: mocks.check, forget: vi.fn() } }))
vi.mock('../src/main/connectors/connector-service', () => ({ connectors: { notify: vi.fn() } }))
vi.mock('../src/main/models/registry', () => ({ resolveModel: mocks.model }))
import { tasks } from '../src/main/tasks/task-service'

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const task = (kind: Task['kind'] = 'agent') =>
  tasks.save({
    name: 'Task',
    prompt: 'Work',
    modelId: 'model',
    cron: null,
    enabled: true,
    kind,
    macroId: kind === 'flow' ? 'macro' : null,
    monitor: kind === 'monitor' ? ({ url: 'https://example.org', action: 'agent', prompt: 'Notify' } as Task['monitor']) : null,
  })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.db = new DatabaseSync(':memory:')
  mocks.db
    .exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,name TEXT,prompt TEXT,model_id TEXT,cron TEXT,enabled INTEGER,created_at INTEGER,kind TEXT,macro_id TEXT,params TEXT,monitor TEXT);
  CREATE TABLE task_runs(id TEXT PRIMARY KEY,task_id TEXT,thread_id TEXT,execution_id TEXT,status TEXT,started_at INTEGER,finished_at INTEGER,summary TEXT,error TEXT);`)
  mocks.create.mockReturnValue({ id: 'thread' })
  mocks.send.mockImplementation(() => new Promise(() => {}))
  mocks.state.mockResolvedValue({ interrupt: null })
  mocks.model.mockReturnValue({})
  tasks.init()
})
afterEach(() => {
  tasks.stopAll()
  mocks.db.close()
})

describe('task execution lifecycle', () => {
  it('records dependency failures before creating a conversation', () => {
    mocks.create.mockImplementationOnce(() => {
      throw new Error('disabled model')
    })
    const run = tasks.run(task().id)
    expect(tasks.runs()[0]).toMatchObject({ id: run.id, status: 'error', error: 'disabled model', threadId: '' })
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('retains waiting approval and completes the original record once after resume', async () => {
    mocks.send.mockResolvedValueOnce({ interrupted: true, finalText: '' })
    const item = task(),
      run = tasks.run(item.id)
    await settle()
    expect(tasks.runs()[0]).toMatchObject({ id: run.id, status: 'waiting_approval', finishedAt: null })
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(tasks.run(item.id).status).toBe('skipped')
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const event = { threadId: run.threadId, executionId: run.executionId!, phase: 'success', result: { finalText: 'Done' } }
    mocks.listener!(event)
    mocks.listener!(event)
    expect(tasks.runs().find((r) => r.id === run.id)).toMatchObject({ status: 'success', summary: 'Done' })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })
  it('cancel prevents a late completion from overwriting the task outcome', async () => {
    const run = tasks.run(task().id)
    tasks.cancel(run.id)
    mocks.listener!({ threadId: run.threadId, executionId: run.executionId!, phase: 'success', result: { finalText: 'Late' } })
    expect(tasks.runs()[0].status).toBe('cancelled')
    expect(mocks.stop).toHaveBeenCalledWith('thread')
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })
  it('flow cancellation reaches the replay signal and a repair thread immediately', () => {
    mocks.flow.mockImplementation((_id, _params, _repair, options) => {
      options.onRepairThread('repair-thread')
      return new Promise(() => {})
    })
    const run = tasks.run(task('flow').id)
    const signal = mocks.flow.mock.calls[0][3].signal as AbortSignal
    tasks.cancel(run.id)
    expect(signal.aborted).toBe(true)
    expect(mocks.stop).toHaveBeenCalledWith('repair-thread')
    expect(tasks.runs()[0].status).toBe('cancelled')
  })
  it('skips overlapping monitor triggers without recording another monitor check', async () => {
    let trigger!: (summary: string) => Promise<string>
    let finish!: (value: unknown) => void
    mocks.check.mockImplementation((_task, callback) => {
      trigger = callback
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const item = task('monitor')
    const first = tasks.run(item.id)
    expect(tasks.run(item.id).status).toBe('skipped')
    expect(mocks.check).toHaveBeenCalledTimes(1)
    expect(await trigger('Changed')).toBe('thread')
    finish({ summary: 'Changed', triggered: true })
    await settle()
    expect(tasks.runs().find((r) => r.id === first.id)?.status).toBe('running')
    expect(tasks.run(item.id).status).toBe('skipped')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('records routine monitor checks without sending completion notifications', async () => {
    mocks.check.mockResolvedValueOnce({ summary: 'Unchanged', triggered: false, error: null })
    const run = tasks.run(task('monitor').id)
    await settle()
    expect(tasks.runs().find((item) => item.id === run.id)?.status).toBe('success')
    expect(mocks.notify).not.toHaveBeenCalled()
  })
  it('restores only checkpoint-backed approvals and does not replay interrupted work', async () => {
    const item = task()
    const insert = mocks.db.prepare('INSERT INTO task_runs(id,task_id,thread_id,execution_id,status,started_at) VALUES(?,?,?,?,?,1)')
    insert.run('waiting', item.id, 'waiting-thread', 'old', 'waiting_approval')
    insert.run('interrupted', 'other', 'other-thread', 'other', 'running')
    mocks.state.mockImplementation((id) => Promise.resolve({ interrupt: id === 'waiting-thread' ? {} : null }))
    tasks.init()
    await settle()
    expect(tasks.runs().find((r) => r.id === 'waiting')).toMatchObject({ status: 'waiting_approval', finishedAt: null, executionId: 'restored' })
    expect(tasks.runs().find((r) => r.id === 'interrupted')?.status).toBe('cancelled')
    expect(mocks.stop).toHaveBeenCalledWith('other-thread')
    expect(mocks.stop).not.toHaveBeenCalledWith('waiting-thread')
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
