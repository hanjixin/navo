import { Notification } from 'electron'
import cron, { type ScheduledTask } from 'node-cron'
import type { MonitorCheck, MonitorConfig, Task, TaskRun, TaskRunStatus } from '@shared/types'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { agent } from '../agent/agent-service'
import { flows } from '../flows/flows'
import { monitor } from '../monitor/monitor-service'
import { connectors } from '../connectors/connector-service'
import { t } from '@shared/i18n'
import { resolveModel } from '../models/registry'

interface TaskRow {
  id: string
  name: string
  prompt: string
  model_id: string | null
  cron: string | null
  enabled: number
  created_at: number
  kind: 'agent' | 'flow' | 'monitor'
  macro_id: string | null
  params: string | null
  monitor: string | null
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
  execution_id: string | null
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
  executionId: r.execution_id,
})

class TaskService {
  private jobs = new Map<string, ScheduledTask>()
  private controllers = new Map<string, AbortController>()
  private recovering = new Set<string>()
  private flowRepairsPending = new Set<string>()
  private unsubscribe?: () => void

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
        monitor: json.parse<MonitorConfig>(r.monitor),
        createdAt: r.created_at,
        lastRunAt: last?.started_at ?? null,
        lastStatus: last?.status ?? null,
      }
    })
  }

  get(id: string): Task {
    const found = this.list().find((x) => x.id === id)
    if (!found) throw new Error(t('任务不存在'))
    return found
  }

  save(input: Omit<Task, 'id' | 'createdAt'> & { id?: string }): Task {
    const kind = input.kind ?? 'agent'
    if (!input.name.trim()) throw new Error(t('名称必填'))
    if (kind === 'agent' && !input.prompt.trim()) throw new Error(t('任务描述必填'))
    if (kind === 'flow' && !input.macroId) throw new Error(t('请选择要回放的固定流程'))
    if (kind === 'monitor') {
      const url = input.monitor?.url.trim() ?? ''
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(t('请填写要监控的网址（http:// 或 https:// 开头）'))
      if (input.monitor?.action === 'agent' && !input.monitor.prompt?.trim()) throw new Error(t('请填写触发后让 Agent 做什么'))
    }
    if (input.cron && !cron.validate(input.cron)) throw new Error(t('Cron 表达式无效'))
    const id = input.id ?? newId()
    db()
      .prepare(
        `INSERT INTO tasks(id, name, prompt, model_id, cron, enabled, created_at, kind, macro_id, params, monitor) VALUES(@id, @name, @prompt, @modelId, @cron, @enabled, @now, @kind, @macroId, @params, @monitor)
         ON CONFLICT(id) DO UPDATE SET name=@name, prompt=@prompt, model_id=@modelId, cron=@cron, enabled=@enabled, kind=@kind, macro_id=@macroId, params=@params, monitor=@monitor`,
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
        monitor: kind === 'monitor' ? json.str({ ...input.monitor!, url: input.monitor!.url.trim() }) : null,
      })
    this.schedule(this.get(id))
    emit('tasks.changed')
    return this.get(id)
  }

  delete(id: string): void {
    for (const run of this.runs(id)) if (['running', 'queued', 'waiting_approval'].includes(run.status)) this.cancel(run.id)
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    db().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    monitor.forget(id)
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

  private begin(task: Task): RunRow {
    const busy =
      this.recovering.has(task.id) ||
      !!db().prepare("SELECT id FROM task_runs WHERE task_id = ? AND status IN ('running', 'queued', 'waiting_approval') LIMIT 1").get(task.id)
    const run: RunRow = {
      id: newId(),
      task_id: task.id,
      thread_id: '',
      execution_id: newId(),
      status: busy ? 'skipped' : 'running',
      started_at: Date.now(),
      finished_at: busy ? Date.now() : null,
      summary: busy ? t('上一次运行尚未结束，本次已跳过') : null,
      error: null,
    }
    db()
      .prepare(
        'INSERT INTO task_runs(id, task_id, thread_id, execution_id, status, started_at, finished_at, summary) VALUES(@id, @task_id, @thread_id, @execution_id, @status, @started_at, @finished_at, @summary)',
      )
      .run(run)
    if (!busy) this.controllers.set(run.id, new AbortController())
    emit('tasks.changed')
    return run
  }

  private active(id: string): boolean {
    return !!db().prepare("SELECT id FROM task_runs WHERE id = ? AND status IN ('running', 'queued', 'waiting_approval')").get(id)
  }

  private finish(run: RunRow, status: TaskRunStatus, summary: string | null, error: string | null = null): void {
    if (!this.active(run.id)) return
    if (status === 'cancelled') {
      summary ||= t('已取消')
      error = null
    }
    this.updateRun(run.id, { status, summary, error, finished_at: status === 'waiting_approval' ? null : Date.now() })
    if (status === 'waiting_approval') return
    this.controllers.delete(run.id)
    const task = db().prepare('SELECT name, kind FROM tasks WHERE id = ?').get(run.task_id) as { name: string; kind: Task['kind'] } | undefined
    // Routine monitor checks stay in history; only triggered work sends task completion notifications.
    if (task?.kind === 'monitor' && !run.thread_id) return
    if (task && Notification.isSupported())
      new Notification({
        title:
          status === 'success'
            ? t('任务完成：{{v0}}', { v0: task.name })
            : status === 'cancelled'
              ? t('任务已取消：{{v0}}', { v0: task.name })
              : t('任务失败：{{v0}}', { v0: task.name }),
        body: (error ?? summary ?? '').slice(0, 120),
      }).show()
  }

  run(taskId: string): TaskRun {
    const task = this.get(taskId)
    const run = this.begin(task)
    if (run.status === 'skipped') return toRun(run)
    if (task.kind === 'flow') this.runFlow(task, run)
    else if (task.kind === 'monitor') void this.checkRun(task, run).catch((err: Error) => this.finish(run, 'error', null, err.message))
    else this.runAgent(task, task.prompt, t('任务：{{v0}}', { v0: task.name }), run)
    return toRun(run)
  }

  async check(task: Task): Promise<MonitorCheck> {
    const run = this.begin(task)
    if (run.status === 'skipped')
      return {
        id: run.id,
        taskId: task.id,
        at: run.started_at,
        first: false,
        changed: false,
        triggered: false,
        summary: run.summary,
        error: null,
        added: [],
        removed: [],
        threadId: null,
        repeats: 0,
        lastAt: run.started_at,
      }
    return this.checkRun(task, run)
  }

  private async checkRun(task: Task, run: RunRow): Promise<MonitorCheck> {
    let handedOff = false
    try {
      resolveModel(task.modelId)
      const result = await monitor.check(
        task,
        async (summary) => {
          if (!this.active(run.id)) return null
          const cfg = task.monitor!
          if (cfg.notifyConnector)
            await connectors
              .notify(cfg.notifyConnector, { title: t('监控提醒：{{v0}}', { v0: task.name }), text: `${summary}\n\n[打开网页](${cfg.url})` })
              .catch((err: Error) => log.warn(`[tasks] monitor alert failed: ${err.message}`))
          if (!this.active(run.id) || cfg.action !== 'agent' || !cfg.prompt?.trim()) return null
          handedOff = true
          this.runAgent(
            task,
            `${cfg.prompt.trim()}\n\n（这是网页监控「${task.name}」触发后的任务。触发原因：${summary}。网页：${cfg.url}）`,
            t('监控：{{v0}}', { v0: task.name }),
            run,
          )
          return run.thread_id || null
        },
        this.controllers.get(run.id)?.signal,
      )
      if (!handedOff) this.finish(run, result.error ? 'error' : 'success', result.summary ?? null, result.error ?? null)
      return result
    } catch (err) {
      this.finish(run, this.controllers.get(run.id)?.signal.aborted ? 'cancelled' : 'error', null, (err as Error).message)
      throw err
    }
  }

  private runAgent(task: Task, prompt: string, title: string, run: RunRow): void {
    try {
      const thread = agent.createThread(task.modelId, { title })
      run.thread_id = thread.id
      this.updateRun(run.id, { thread_id: thread.id })
      void agent.send_(thread.id, prompt, [], { executionId: run.execution_id! }).then(
        (res) => {
          this.finish(
            run,
            res.aborted ? 'cancelled' : res.error ? 'error' : res.interrupted ? 'waiting_approval' : 'success',
            res.interrupted ? t('等待人工确认，请打开会话处理') : res.finalText.slice(0, 500),
            res.error ?? null,
          )
        },
        (err: Error) => this.finish(run, 'error', null, err.message),
      )
    } catch (err) {
      this.finish(run, 'error', null, (err as Error).message)
    }
  }

  private runFlow(task: Task, run: RunRow): void {
    const controller = this.controllers.get(run.id)!
    this.flowRepairsPending.add(run.id)
    void flows
      .run(task.macroId!, task.params ?? {}, true, {
        signal: controller.signal,
        executionId: run.execution_id!,
        modelId: task.modelId,
        onRepairThread: (threadId) => {
          run.thread_id = threadId
          this.updateRun(run.id, { thread_id: threadId })
        },
      })
      .then(
        (res) => {
          const summary = res.interrupted
            ? t('等待人工确认，请打开会话处理')
            : res.ok
              ? `${res.repaired ? t('回放中途页面有变化，已由 Agent 完成并更新流程') : t('按固定流程回放完成，未调用模型')}\n${Object.entries(res.extracted)
                  .map(([k, v]) => `${k}：${v.slice(0, 200)}`)
                  .join('\n')}`
              : null
          this.finish(
            run,
            controller.signal.aborted || res.aborted ? 'cancelled' : res.interrupted ? 'waiting_approval' : res.ok ? 'success' : 'error',
            summary,
            res.ok || res.interrupted ? null : (res.error ?? null),
          )
        },
        (err: Error) => this.finish(run, controller.signal.aborted ? 'cancelled' : 'error', null, err.message),
      )
      .finally(() => this.flowRepairsPending.delete(run.id))
  }

  cancel(runId: string): void {
    const run = db().prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as RunRow | undefined
    if (!run || !this.active(runId)) return
    this.controllers.get(runId)?.abort()
    this.finish(run, 'cancelled', t('已取消'))
    if (run.thread_id) agent.stop(run.thread_id)
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
    this.unsubscribe?.()
    this.unsubscribe = agent.subscribeExecution((event) => {
      const row = db()
        .prepare("SELECT * FROM task_runs WHERE execution_id = ? AND thread_id = ? AND status IN ('running', 'queued', 'waiting_approval') LIMIT 1")
        .get(event.executionId, event.threadId) as RunRow | undefined
      if (!row) return
      if (this.flowRepairsPending.has(row.id) && event.phase !== 'waiting_approval') return
      if (event.phase === 'running') this.updateRun(row.id, { status: 'running', finished_at: null })
      else
        this.finish(
          row,
          event.phase,
          event.phase === 'waiting_approval' ? t('等待人工确认，请打开会话处理') : (event.result?.finalText.slice(0, 500) ?? null),
          event.result?.error ?? null,
        )
    })
    const rows = db().prepare("SELECT * FROM task_runs WHERE status IN ('running', 'queued', 'waiting_approval')").all() as RunRow[]
    for (const row of rows) {
      this.recovering.add(row.task_id)
      void (row.thread_id ? agent.threadState(row.thread_id) : Promise.resolve(null))
        .then(
          (state) => {
            if (!this.active(row.id)) return
            if (state?.interrupt)
              this.updateRun(row.id, {
                status: 'waiting_approval',
                finished_at: null,
                execution_id: agent.executionId(row.thread_id),
                summary: t('等待人工确认，请打开会话处理'),
              })
            else this.interruptRecovered(row)
          },
          () => this.interruptRecovered(row),
        )
        .finally(() => this.recovering.delete(row.task_id))
    }
    for (const found of this.list()) this.schedule(found)
  }

  private interruptRecovered(row: RunRow): void {
    if (!this.active(row.id)) return
    this.finish(row, 'cancelled', t('应用重启，任务已中断，请手动重新运行'))
    if (row.thread_id) agent.stop(row.thread_id)
  }

  stopAll(): void {
    this.unsubscribe?.()
    for (const controller of this.controllers.values()) controller.abort()
    for (const j of this.jobs.values()) j.stop()
  }
}

export const tasks = new TaskService()
