import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { Notification } from 'electron'
import { costOf } from '@shared/pricing'
import type { ModelPricing, UsagePurpose, UsageReport, UsageTotals } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { getSettings } from '../core/settings'
import { buildChatModel } from '../models/factory'
import { models, resolveModel } from '../models/registry'
import { type TokenUsage, UsageHandler } from '../models/usage-callback'
import { t } from '@shared/i18n'

/** Navo's own passes in the background: these wait when the daily budget is used up (if the user asked so) */
export const BACKGROUND: UsagePurpose[] = ['memory', 'memory-tidy', 'skill', 'monitor']

interface Agg {
  calls: number
  input: number
  output: number
  cached: number
}

const empty = (): UsageTotals => ({ calls: 0, input: 0, output: 0, cached: 0, cost: {}, unpriced: 0 })
const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()

/** Token usage of every model call, and what it cost at the prices set on the models. */
class UsageService {
  private alertedDay = ''

  record(e: { modelId?: string | null; model: string; purpose: UsagePurpose; threadId?: string | null; usage: TokenUsage }): void {
    db()
      .prepare('INSERT INTO usage(id, at, model_id, model, purpose, thread_id, input_tokens, output_tokens, cached_tokens) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), Date.now(), e.modelId ?? null, e.model, e.purpose, e.threadId ?? null, e.usage.input, e.usage.output, e.usage.cached)
    emit('usage.changed')
    this.checkBudget()
  }

  private pricing(): Map<string, ModelPricing> {
    return new Map(models.list().flatMap((m) => (m.pricing ? [[m.id, m.pricing] as const] : [])))
  }

  /** Adds an aggregate to totals, priced by its model. */
  private add(t: UsageTotals, a: Agg, price: ModelPricing | undefined): void {
    t.calls += a.calls
    t.input += a.input
    t.output += a.output
    t.cached += a.cached
    const c = costOf(a, price)
    if (c == null || !price) t.unpriced += a.input + a.output
    else t.cost[price.currency] = (t.cost[price.currency] ?? 0) + c
  }

  /** Estimated spend since midnight in the budget's currency. */
  spentToday(): number {
    const currency = getSettings().usage.currency
    const prices = this.pricing()
    const rows = db()
      .prepare(
        'SELECT model_id, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached FROM usage WHERE at >= ? GROUP BY model_id',
      )
      .all(startOfToday()) as ({ model_id: string | null } & Agg)[]
    const t = empty()
    for (const r of rows) this.add(t, r, prices.get(r.model_id ?? ''))
    return t.cost[currency] ?? 0
  }

  private overBudget(): boolean {
    const b = getSettings().usage.dailyBudget
    return b != null && b > 0 && this.spentToday() >= b
  }

  /** Whether a background pass may call the model now. */
  allows(purpose: UsagePurpose): boolean {
    if (!BACKGROUND.includes(purpose)) return true
    return !(getSettings().usage.pauseBackground && this.overBudget())
  }

  /** Tells the user once a day when the budget is used up. */
  private checkBudget(): void {
    const day = new Date().toDateString()
    if (this.alertedDay === day || !this.overBudget()) return
    this.alertedDay = day
    const s = getSettings().usage
    if (Notification.isSupported())
      new Notification({
        title: t('今日模型用量已达预算'),
        body: s.pauseBackground ? t('记忆整理、Skill 复盘和网页监控的判断会暂停到明天；对话不受影响。') : t('可以在「用量」页面查看明细。'),
      }).show()
  }

  report(days = 7): UsageReport {
    const since = startOfToday() - (days - 1) * 86_400_000
    const prices = this.pricing()
    const names = new Map(models.list().map((m) => [m.id, m.displayName]))
    const rows = db()
      .prepare(
        `SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, model_id, model, purpose, COUNT(*) AS calls,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached
         FROM usage WHERE at >= ? GROUP BY day, model_id, model, purpose`,
      )
      .all(since) as ({ day: string; model_id: string | null; model: string; purpose: UsagePurpose } & Agg)[]
    const today = new Date().toLocaleDateString('sv') // YYYY-MM-DD, local
    const total = empty()
    const todayT = empty()
    const daily = new Map<string, UsageTotals>()
    const byPurpose = new Map<UsagePurpose, UsageTotals>()
    const byModel = new Map<string, { modelId: string | null; name: string } & UsageTotals>()
    for (let i = days - 1; i >= 0; i--) daily.set(new Date(Date.now() - i * 86_400_000).toLocaleDateString('sv'), empty())
    for (const r of rows) {
      const price = prices.get(r.model_id ?? '')
      this.add(total, r, price)
      if (r.day === today) this.add(todayT, r, price)
      if (daily.has(r.day)) this.add(daily.get(r.day)!, r, price)
      if (!byPurpose.has(r.purpose)) byPurpose.set(r.purpose, empty())
      this.add(byPurpose.get(r.purpose)!, r, price)
      const key = r.model_id ?? `name:${r.model}`
      if (!byModel.has(key)) byModel.set(key, { modelId: r.model_id, name: names.get(r.model_id ?? '') ?? r.model, ...empty() })
      this.add(byModel.get(key)!, r, price)
    }
    const threadRows = db()
      .prepare(
        `SELECT u.thread_id, t.title, u.model_id, COUNT(*) AS calls, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output, SUM(u.cached_tokens) AS cached
         FROM usage u LEFT JOIN threads t ON t.id = u.thread_id
         WHERE u.at >= ? AND u.thread_id IS NOT NULL GROUP BY u.thread_id, u.model_id`,
      )
      .all(since) as ({ thread_id: string; title: string | null; model_id: string | null } & Agg)[]
    const threads = new Map<string, { threadId: string; title: string } & UsageTotals>()
    for (const r of threadRows) {
      if (!threads.has(r.thread_id)) threads.set(r.thread_id, { threadId: r.thread_id, title: r.title ?? t('已删除的对话'), ...empty() })
      this.add(threads.get(r.thread_id)!, r, prices.get(r.model_id ?? ''))
    }
    const tokens = (t: UsageTotals) => t.input + t.output
    const s = getSettings().usage
    return {
      days,
      today: todayT,
      total,
      daily: [...daily].map(([day, t]) => ({ day, ...t })),
      byPurpose: [...byPurpose].map(([purpose, t]) => ({ purpose, ...t })).sort((a, b) => tokens(b) - tokens(a)),
      byModel: [...byModel.values()].sort((a, b) => tokens(b) - tokens(a)),
      topThreads: [...threads.values()].sort((a, b) => tokens(b) - tokens(a)).slice(0, 8),
      budget: { daily: s.dailyBudget, currency: s.currency, spentToday: todayT.cost[s.currency] ?? 0, paused: s.pauseBackground && this.overBudget() },
    }
  }
}

export const usage = new UsageService()

/**
 * A chat model whose calls are recorded under `purpose`. Background passes are refused while the
 * daily budget is used up and the user asked to pause them.
 */
export function trackedModel(modelId: string | null | undefined, purpose: UsagePurpose, threadId?: string | null): BaseChatModel {
  if (!usage.allows(purpose)) throw new Error(t('今日模型用量已达预算，后台调用已暂停'))
  const r = resolveModel(modelId)
  return buildChatModel(r, [new UsageHandler((u) => usage.record({ modelId: r.id, model: r.model, purpose, threadId, usage: u }))])
}
