import { Notification } from 'electron'
import type { MonitorCheck, MonitorSummary, Task } from '@shared/types'
import { browser } from '../browser/browser-service'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { trackedModel } from '../usage/usage-service'
import { diffLines, FAIL_ALERT, hashText, judgeMessages, normalize, parseJudge } from './monitor-core'
import { t } from '@shared/i18n'

interface CheckRow {
  id: string
  task_id: string
  at: number
  first: number
  hash: string | null
  text: string | null
  changed: number
  triggered: number
  summary: string | null
  error: string | null
  added: string | null
  removed: string | null
  thread_id: string | null
  repeats: number
  last_at: number | null
}

const toCheck = (r: CheckRow): MonitorCheck => ({
  id: r.id,
  taskId: r.task_id,
  at: r.at,
  first: !!r.first,
  changed: !!r.changed,
  triggered: !!r.triggered,
  summary: r.summary,
  error: r.error,
  added: json.parse<string[]>(r.added) ?? [],
  removed: json.parse<string[]>(r.removed) ?? [],
  threadId: r.thread_id,
  repeats: r.repeats,
  lastAt: r.last_at ?? r.at,
})

const blank = (taskId: string): Omit<CheckRow, 'id' | 'at' | 'repeats' | 'last_at'> => ({
  task_id: taskId,
  first: 0,
  hash: null,
  text: null,
  changed: 0,
  triggered: 0,
  summary: null,
  error: null,
  added: null,
  removed: null,
  thread_id: null,
})

/** checks kept per monitor */
const KEEP = 300
/** time for scripts to fill the page after it loaded */
const SETTLE_MS = 1500

/**
 * Web page monitors: each check reads the page in a background tab. Unchanged text costs nothing;
 * a change is shown to the model once, which decides whether it meets the condition.
 */
class MonitorService {
  private busy = new Set<string>()

  /** Reads the watched part of a page as text. */
  async read(url: string, selector?: string | null): Promise<{ text: string; title: string }> {
    const tabId = browser.newTab(url, { activate: false })
    const wc = browser.tab(tabId)!
    let status = 0
    wc.on('did-navigate', (_e, _url, code) => (status = code))
    try {
      // the load starts asynchronously: wait for it to begin, then to finish
      await new Promise((r) => setTimeout(r, 300))
      await browser.waitForLoad(wc, 30_000)
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      if (wc.getURL().startsWith('chrome-error:')) throw new Error(t('页面打不开'))
      if (status >= 400) throw new Error(t('页面返回错误 {{v0}}', { v0: status }))
      const found = selector ? await browser.evalIn<boolean>(wc, `!!document.querySelector(${JSON.stringify(selector)})`) : true
      if (!found) throw new Error(t('页面上没有找到要看的区域（{{v0}}）', { v0: selector }))
      const text = normalize(await browser.evalIn<string>(wc, `__agent.extract(${JSON.stringify(selector || null)} || undefined, 50000)`))
      if (!text) throw new Error(t('页面没有可读的文字'))
      return { text, title: wc.getTitle() }
    } finally {
      browser.closeTab(tabId)
    }
  }

  private last(taskId: string): CheckRow | null {
    return (
      (db().prepare('SELECT * FROM monitor_checks WHERE task_id = ? AND hash IS NOT NULL ORDER BY at DESC LIMIT 1').get(taskId) as CheckRow | undefined) ?? null
    )
  }

  private insert(row: Omit<CheckRow, 'id' | 'at' | 'repeats' | 'last_at'>): MonitorCheck {
    const full: CheckRow = { id: newId(), at: Date.now(), repeats: 1, last_at: null, ...row }
    db()
      .prepare(
        `INSERT INTO monitor_checks(id, task_id, at, first, hash, text, changed, triggered, summary, error, added, removed, thread_id, repeats, last_at)
         VALUES(@id, @task_id, @at, @first, @hash, @text, @changed, @triggered, @summary, @error, @added, @removed, @thread_id, @repeats, @last_at)`,
      )
      .run(full)
    db()
      .prepare('DELETE FROM monitor_checks WHERE task_id = ? AND id NOT IN (SELECT id FROM monitor_checks WHERE task_id = ? ORDER BY at DESC LIMIT ?)')
      .run(row.task_id, row.task_id, KEEP)
    return toCheck(full)
  }

  /**
   * One check. `onTrigger` runs when the condition is met (the task service starts the agent there)
   * and may return the thread it started.
   */
  async check(task: Task, onTrigger?: (summary: string) => Promise<string | null>): Promise<MonitorCheck> {
    const cfg = task.monitor
    if (!cfg) throw new Error(t('这个任务不是网页监控'))
    if (this.busy.has(task.id)) throw new Error(t('上一次检查还没有结束'))
    this.busy.add(task.id)
    const base = blank(task.id)
    let result: MonitorCheck
    try {
      result = await this.compare(task, onTrigger)
    } catch (err) {
      log.warn(`[monitor] ${task.name}: ${(err as Error).message}`)
      result = this.insert({ ...base, error: (err as Error).message })
      // a few failures in a row (not every one after that): the page may have moved or gone
      if (this.summary(task.id).failStreak === FAIL_ALERT)
        this.notify(t('监控连续 {{v0}} 次检查失败：{{v1}}', { v0: FAIL_ALERT, v1: task.name }), (err as Error).message)
    } finally {
      this.busy.delete(task.id)
    }
    emit('monitor.checked', { taskId: task.id, triggered: result.triggered })
    emit('tasks.changed')
    return result
  }

  private async compare(task: Task, onTrigger?: (summary: string) => Promise<string | null>): Promise<MonitorCheck> {
    const cfg = task.monitor!
    const base = blank(task.id)
    const { text } = await this.read(cfg.url, cfg.selector)
    const hash = hashText(text)
    const prev = this.last(task.id)
    if (!prev) {
      return this.insert({ ...base, first: 1, hash, text, summary: t('已记录当前内容，之后有变化时再判断') })
    } else if (prev.hash === hash) {
      // unchanged: no model call. A run of unchanged checks is one row, so the history keeps what happened
      const latest = db().prepare('SELECT * FROM monitor_checks WHERE task_id = ? ORDER BY at DESC LIMIT 1').get(task.id) as CheckRow
      if (latest.id === prev.id && !latest.first && !latest.changed && !latest.error) {
        db().prepare('UPDATE monitor_checks SET repeats = repeats + 1, last_at = ? WHERE id = ?').run(Date.now(), latest.id)
        return toCheck({ ...latest, repeats: latest.repeats + 1, last_at: Date.now() })
      }
      return this.insert({ ...base, hash })
    } else {
      const prevText =
        prev.text ??
        (
          db()
            .prepare('SELECT text FROM monitor_checks WHERE task_id = ? AND hash = ? AND text IS NOT NULL ORDER BY at DESC LIMIT 1')
            .get(task.id, prev.hash) as { text: string } | undefined
        )?.text ??
        ''
      const { added, removed } = diffLines(prevText, text)
      // only the order of lines changed (a carousel, a re-sorted list): nothing to ask about
      if (!added.length && !removed.length) {
        return this.insert({ ...base, hash, text })
      }
      const res = await trackedModel(task.modelId ?? null, 'monitor').invoke(
        judgeMessages({ url: cfg.url, focus: cfg.focus, condition: cfg.condition, prev: prevText, cur: text, added, removed }),
      )
      const out = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
      const verdict = parseJudge(out)
      // without a verdict the new text doesn't become the baseline: the next check compares again
      if (!verdict) throw new Error(t('模型没有给出可用的判断'))
      const threadId = verdict.triggered ? ((await onTrigger?.(verdict.summary)) ?? null) : null
      const check = this.insert({
        ...base,
        hash,
        text,
        changed: 1,
        triggered: verdict.triggered ? 1 : 0,
        summary: verdict.summary,
        added: json.str(added.slice(0, 200)),
        removed: json.str(removed.slice(0, 200)),
        thread_id: threadId,
      })
      if (verdict.triggered) this.notify(t('监控提醒：{{v0}}', { v0: task.name }), verdict.summary)
      return check
    }
  }

  private notify(title: string, body: string): void {
    if (Notification.isSupported()) new Notification({ title, body: body.slice(0, 160) }).show()
  }

  checks(taskId: string, limit = 50): MonitorCheck[] {
    return (db().prepare('SELECT * FROM monitor_checks WHERE task_id = ? ORDER BY at DESC LIMIT ?').all(taskId, limit) as CheckRow[]).map(toCheck)
  }

  summary(taskId: string): MonitorSummary {
    const recent = db()
      .prepare('SELECT COALESCE(last_at, at) AS at, error, summary, changed FROM monitor_checks WHERE task_id = ? ORDER BY at DESC LIMIT 20')
      .all(taskId) as {
      at: number
      error: string | null
      summary: string | null
      changed: number
    }[]
    const counts = db()
      .prepare('SELECT COALESCE(SUM(repeats), 0) AS n, COALESCE(SUM(triggered), 0) AS t FROM monitor_checks WHERE task_id = ?')
      .get(taskId) as {
      n: number
      t: number
    }
    let failStreak = 0
    while (failStreak < recent.length && recent[failStreak].error) failStreak++
    return {
      lastAt: recent[0]?.at ?? null,
      checks: counts.n,
      triggers: counts.t,
      failStreak,
      lastSummary: recent.find((r) => r.changed && r.summary)?.summary ?? null,
    }
  }

  summaries(taskIds: string[]): Record<string, MonitorSummary> {
    return Object.fromEntries(taskIds.map((id) => [id, this.summary(id)]))
  }

  forget(taskId: string): void {
    db().prepare('DELETE FROM monitor_checks WHERE task_id = ?').run(taskId)
  }
}

export const monitor = new MonitorService()
