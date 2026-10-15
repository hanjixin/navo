import { Notification } from 'electron'
import cron, { type ScheduledTask } from 'node-cron'
import type { Task, TaskRun, TaskRunStatus } from '@shared/types'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { agent } from '../agent/agent-service'
import { flows } from '../flows/flows'

interface TaskRow {
  id: string
  name: string
  prompt: string
  model_id: string | null
  cron: string | null
  enabled: number
  created_at: number
  kind: 'agent' | 'flow'
  macro_id: string | null
  params: string | null
}

interface RunRow {
  id: string
  task_id: string
  thread_id: string
  status: TaskRunStatus
  started_at: number
  finished_at: number | null
  summary: string | null
  error: string | null
}

const toRun = (r: RunRow): TaskRun => ({
  id: r.id,
  taskId: r.task_id,
  threadId: r.thread_id,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  summary: r.summary,
  error: r.error,
})

class TaskService {
  private jobs = new Map<string, ScheduledTask>()

  list(): Task[] {
    const rows = db().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[]
    return rows.map((r) => {
      const last = db().prepare('SELECT status, started_at FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(r.id) as
        { status: TaskRunStatus; started_at: number } | undefined
      return {
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        modelId: r.model_id,
        cron: r.cron,
        enabled: !!r.enabled,
        kind: r.kind ?? 'agent',
        macroId: r.macro_id,
        params: json.parse<Record<string, string>>(r.params),
        createdAt: r.created_at,
        lastRunAt: last?.started_at ?? null,
        lastStatus: last?.status ?? null,
      }
    })
  }

  get(id: string): Task {
    const t = this.list().find((x) => x.id === id)
    if (!t) throw new Error('任务不存在')
    return t
  }

  save(input: Omit<Task, 'id' | 'createdAt'> & { id?: string }): Task {
    const kind = input.kind ?? 'agent'
    if (!input.name.trim()) throw new Error('名称必填')
    if (kind === 'agent' && !input.prompt.trim()) throw new Error('任务描述必填')
    if (kind === 'flow' && !input.macroId) throw new Error('请选择要回放的固定流程')
    if (input.cron && !cron.validate(input.cron)) throw new Error('Cron 表达式无效')
    const id = input.id ?? newId()
    db()
      .prepare(
        `INSERT INTO tasks(id, name, prompt, model_id, cron, enabled, created_at, kind, macro_id, params) VALUES(@id, @name, @prompt, @modelId, @cron, @enabled, @now, @kind, @macroId, @params)
         ON CONFLICT(id) DO UPDATE SET name=@name, prompt=@prompt, model_id=@modelId, cron=@cron, enabled=@enabled, kind=@kind, macro_id=@macroId, params=@params`,
      )
      .run({
        id,
        name: input.name.trim(),
        prompt: input.prompt,
        modelId: input.modelId ?? null,
        cron: input.cron || null,
        enabled: input.enabled ? 1 : 0,
        now: Date.now(),
        kind,
        macroId: kind === 'flow' ? input.macroId : null,
        params: kind === 'flow' ? json.str(input.params ?? {}) : null,
      })
    this.schedule(this.get(id))
    emit('tasks.changed')
    return this.get(id)
  }

  delete(id: string): void {
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    db().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    emit('tasks.changed')
  }

  runs(taskId?: string): TaskRun[] {
    const rows = (
      taskId
        ? db().prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 100').all(taskId)
        : db().prepare('SELECT * FROM task_runs ORDER BY started_at DESC LIMIT 100').all()
    ) as RunRow[]
    return rows.map(toRun)
  }

  private updateRun(id: string, patch: Partial<Omit<RunRow, 'id'>>): void {
    const sets = Object.keys(patch)
      .map((k) => `${k} = @${k}`)
      .join(', ')
    db()
      .prepare(`UPDATE task_runs SET ${sets} WHERE id = @id`)
      .run({ ...patch, id })
    emit('tasks.changed')
  }

  run(taskId: string): TaskRun {
    const task = this.get(taskId)
    if (task.kind === 'flow') return this.runFlow(task)
    const thread = agent.createThread(task.modelId, { title: `任务：${task.name}` })
    const run: RunRow = {
      id: newId(),
      task_id: taskId,
      thread_id: thread.id,
      status: 'running',
      started_at: Date.now(),
      finished_at: null,
      summary: null,
      error: null,
    }
    db().prepare('INSERT INTO task_runs(id, task_id, thread_id, status, started_at) VALUES(@id, @task_id, @thread_id, @status, @started_at)').run(run)
    emit('tasks.changed')

    void agent.send_(thread.id, task.prompt).then(
      (res) => {
        const status: TaskRunStatus = res.aborted ? 'cancelled' : res.error ? 'error' : 'success'
        this.updateRun(run.id, {
          status,
          finished_at: Date.now(),
          summary: res.interrupted ? '等待人工确认，请打开会话处理' : res.finalText.slice(0, 500),
          error: res.error ?? null,
        })
        if (Notification.isSupported()) {
          new Notification({
            title: `任务${status === 'success' ? '完成' : status === 'cancelled' ? '已取消' : '失败'}：${task.name}`,
            body: (res.error ?? res.finalText).slice(0, 120),
          }).show()
        }
      },
      (err: Error) => this.updateRun(run.id, { status: 'error', finished_at: Date.now(), error: err.message }),
    )
    return toRun(run)
  }

  /** A fixed flow: replayed without the model; if a step broke, the agent finished it (and fixed the flow). */
  private runFlow(task: Task): TaskRun {
    const run: RunRow = {
      id: newId(),
      task_id: task.id,
      thread_id: '',
      status: 'running',
      started_at: Date.now(),
      finished_at: null,
      summary: null,
      error: null,
    }
    db().prepare('INSERT INTO task_runs(id, task_id, thread_id, status, started_at) VALUES(@id, @task_id, @thread_id, @status, @started_at)').run(run)
    emit('tasks.changed')
    void flows.run(task.macroId!, task.params ?? {}, true).then(
      (res) => {
        const extracted = Object.entries(res.extracted)
          .map(([k, v]) => `${k}：${v.slice(0, 200)}`)
          .join('\n')
        const summary = res.ok
          ? `${res.repaired ? '回放中途页面有变化，已由 Agent 完成并更新流程' : '按固定流程回放完成，未调用模型'}${extracted ? `\n${extracted}` : ''}`
          : null
        this.updateRun(run.id, {
          status: res.ok ? 'success' : 'error',
          finished_at: Date.now(),
          summary,
          error: res.ok ? null : `第 ${(res.failedStep ?? 0) + 1} 步失败：${res.error ?? ''}`,
          thread_id: res.repairThreadId ?? '',
        })
        if (Notification.isSupported())
          new Notification({ title: `任务${res.ok ? '完成' : '失败'}：${task.name}`, body: (summary ?? res.error ?? '').slice(0, 120) }).show()
      },
      (err: Error) => this.updateRun(run.id, { status: 'error', finished_at: Date.now(), error: err.message }),
    )
    return toRun(run)
  }

  cancel(runId: string): void {
    const r = db().prepare('SELECT thread_id FROM task_runs WHERE id = ?').get(runId) as { thread_id: string } | undefined
    if (r) agent.stop(r.thread_id)
  }

  private schedule(task: Task): void {
    this.jobs.get(task.id)?.stop()
    this.jobs.delete(task.id)
    if (!task.enabled || !task.cron) return
    const job = cron.schedule(task.cron, () => {
      log.info(`[tasks] cron fired: ${task.name}`)
      this.run(task.id)
    })
    this.jobs.set(task.id, job)
  }

  init(): void {
    // runs left in 'running' by a previous session can't be resumed
    db().prepare("UPDATE task_runs SET status = 'cancelled', finished_at = ? WHERE status IN ('running', 'queued')").run(Date.now())
    for (const t of this.list()) this.schedule(t)
  }

  stopAll(): void {
    for (const j of this.jobs.values()) j.stop()
  }
}

export const tasks = new TaskService()
