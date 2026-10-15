import type { FlowDraft, FlowRunResult, FlowStats, Macro, MacroVersion } from '@shared/types'
import { agent } from '../agent/agent-service'
import { sessions } from '../browser/agent-session'
import { browser } from '../browser/browser-service'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { trackedModel } from '../usage/usage-service'
import { recorder } from '../recorder/recorder-service'
import {
  actionCount,
  applyParams,
  describeStep,
  fallbackParams,
  flowMessages,
  MIN_FLOW_ACTIONS,
  parseFlowMeta,
  soundsRepeated,
  splice,
  traceToSteps,
} from './flows-core'
import { trace, type TraceStep } from './trace'
import { t } from '@shared/i18n'

/** a browser task with at least this many actions that sounds recurring gets the "keep as a flow" offer */
const SUGGEST_MIN_ACTIONS = 3

interface TraceRow {
  id: string
  thread_id: string
  at: number
  user_text: string | null
  steps: string
  ok: number
}

/**
 * Fixed flows: what the agent did once with the model is kept as steps that replay without it.
 * When a step breaks (the page changed), the agent finishes the job from there and the flow is
 * updated with what it did — so the model is only needed when something is new.
 */
class Flows {
  private suggested = new Set<string>()

  // ---------- traces

  /** Called when a run ends: keeps its browser trace, and offers a flow when the task sounds recurring. */
  onRunEnd(threadId: string, userText: string, ok: boolean): void {
    const steps = trace.take(threadId)
    if (!steps.length) return
    db()
      .prepare('INSERT INTO run_traces(id, thread_id, at, user_text, steps, ok) VALUES(?, ?, ?, ?, ?, ?)')
      .run(newId(), threadId, Date.now(), userText, JSON.stringify(steps), ok ? 1 : 0)
    // traces are only needed for a while: keep the latest 500
    db().prepare('DELETE FROM run_traces WHERE id NOT IN (SELECT id FROM run_traces ORDER BY at DESC LIMIT 500)').run()
    const actions = actionCount(traceToSteps(steps).steps)
    if (ok && actions >= SUGGEST_MIN_ACTIONS && soundsRepeated(userText) && !this.suggested.has(threadId)) {
      this.suggested.add(threadId)
      emit('flows.suggest', { threadId, actions })
    }
  }

  private lastTrace(threadId: string): TraceRow | null {
    return (db().prepare('SELECT * FROM run_traces WHERE thread_id = ? AND ok = 1 ORDER BY at DESC LIMIT 1').get(threadId) as TraceRow | undefined) ?? null
  }

  traceInfo(threadId: string): { actions: number } | null {
    const row = this.lastTrace(threadId)
    if (!row) return null
    const actions = actionCount(traceToSteps(json.parse<TraceStep[]>(row.steps) ?? []).steps)
    return actions >= MIN_FLOW_ACTIONS ? { actions } : null
  }

  // ---------- creating a flow

  /** The conversation's last successful run as a flow: steps, plus a name and parameters from one model call. */
  async draft(threadId: string): Promise<FlowDraft> {
    const row = this.lastTrace(threadId)
    if (!row) throw new Error(t('这个对话里还没有可以固化的浏览器操作'))
    const flow = traceToSteps(json.parse<TraceStep[]>(row.steps) ?? [])
    if (actionCount(flow.steps) < MIN_FLOW_ACTIONS) throw new Error(t('操作步骤太少，不需要固化'))
    const thread = agent.getThread(threadId)
    let text = ''
    try {
      const res = await trackedModel(thread?.modelId ?? null, 'flow', threadId).invoke(flowMessages(row.user_text ?? '', flow.steps))
      text = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
    } catch (err) {
      log.warn(`[flows] naming failed: ${(err as Error).message}`)
    }
    const meta = parseFlowMeta(text, flow.steps, thread?.title.slice(0, 20) || t('固定流程'))
    if (!meta.params.length) meta.params = fallbackParams(row.user_text ?? '', flow.steps)
    // passwords were never kept: they are asked for when the flow runs
    if (flow.steps.some((s) => s.value === '{{password}}') && !meta.params.some((p) => p.name === 'password'))
      meta.params.push({ name: 'password', description: '登录密码（不保存，运行时填写）', value: '' })
    const withParams = applyParams(flow, meta.params)
    return { threadId, name: meta.name, description: meta.description, startUrl: withParams.startUrl, params: meta.params, steps: withParams.steps }
  }

  save(d: FlowDraft): Macro {
    const now = Date.now()
    const m = recorder.save({
      id: newId(),
      name: d.name.trim() || t('固定流程'),
      description: d.description,
      startUrl: d.startUrl,
      params: d.params.map(({ value: _value, ...p }) => p),
      steps: d.steps,
      exposeAsTool: true,
      createdAt: now,
      updatedAt: now,
    })
    const title = agent.getThread(d.threadId)?.title
    this.recordVersion(m, 'agent', title ? t('由对话「{{v0}}」整理', { v0: title }) : t('由对话整理'))
    return m
  }

  // ---------- versions

  recordVersion(m: Macro, source: MacroVersion['source'], reason: string): number {
    const last = (db().prepare('SELECT MAX(version) AS v FROM macro_versions WHERE macro_id = ?').get(m.id) as { v: number | null }).v ?? 0
    db()
      .prepare('INSERT INTO macro_versions(id, macro_id, version, data, at, source, reason) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), m.id, last + 1, JSON.stringify({ startUrl: m.startUrl, params: m.params, steps: m.steps }), Date.now(), source, reason)
    return last + 1
  }

  versions(macroId: string): MacroVersion[] {
    const rows = db().prepare('SELECT version, at, source, reason, data FROM macro_versions WHERE macro_id = ? ORDER BY version DESC').all(macroId) as {
      version: number
      at: number
      source: MacroVersion['source']
      reason: string | null
      data: string
    }[]
    return rows.map((r) => ({
      version: r.version,
      at: r.at,
      source: r.source,
      reason: r.reason ?? '',
      steps: (json.parse<{ steps: unknown[] }>(r.data)?.steps ?? []).length,
    }))
  }

  rollback(macroId: string, version: number): void {
    const row = db().prepare('SELECT data FROM macro_versions WHERE macro_id = ? AND version = ?').get(macroId, version) as { data: string } | undefined
    if (!row) throw new Error(t('这个版本不存在'))
    const data = json.parse<Pick<Macro, 'startUrl' | 'params' | 'steps'>>(row.data)!
    const m = recorder.save({ ...recorder.get(macroId), ...data })
    this.recordVersion(m, 'rollback', t('回滚到版本 {{v0}}', { v0: version }))
  }

  // ---------- replay (and repair)

  /**
   * Replays a flow in a background tab, without the model. When a step breaks and `repair` is on,
   * the agent takes over from where it stopped; what it does replaces the broken part of the flow.
   */
  async run(macroId: string, params: Record<string, string>, repair: boolean): Promise<FlowRunResult> {
    const m = recorder.get(macroId)
    const tabId = browser.newTab('about:blank', { activate: false })
    const wc = browser.tab(tabId)!
    let keepTab = false
    try {
      const res = await recorder.run(macroId, params, wc, true)
      // where it stopped helps whoever looks at it next (a person, or the agent repairing it)
      if (!res.ok && !wc.isDestroyed()) res.error = `${res.error ?? t('未知错误')}（当时页面：${wc.getTitle() || t('无标题')} ${wc.getURL()}）`
      if (res.ok || !repair) {
        this.recordRun(macroId, res.ok, res.failedStep, res.error, false, 0)
        return res
      }
      keepTab = true // the agent continues in it
      return await this.repair(m, params, res, tabId)
    } finally {
      if (!keepTab) browser.closeTab(tabId)
    }
  }

  private async repair(m: Macro, params: Record<string, string>, failed: FlowRunResult, tabId: number): Promise<FlowRunResult> {
    const step = failed.failedStep ?? 0
    const values = Object.fromEntries(m.params.map((p) => [p.name, params[p.name] ?? p.default ?? '']))
    const fill = (s: string) => s.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k: string) => values[k] ?? '')
    const thread = agent.createThread(null, { title: t('修复流程：{{v0}}', { v0: m.name }) })
    sessions.assign(thread.id, tabId)
    const prompt = [
      `固定流程「${m.name}」${m.description ? `（${m.description}）` : ''}回放到第 ${step + 1} 步时失败了：${fill(describeStep(m.steps[step]))}。错误：${failed.error ?? '未知'}。`,
      '页面现在停在出错的位置。请从这里继续，用浏览器把剩下的事做完（页面可能改版了，按意图操作，不必拘泥于原步骤）。原流程剩下的步骤，仅供参考：',
      ...m.steps.slice(step).map((s, i) => `${step + i + 1}. ${fill(describeStep(s))}`),
      Object.keys(values).length
        ? `本次参数：${Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join('，')}`
        : '',
      '完成后用一句话说明结果。',
    ]
      .filter(Boolean)
      .join('\n')
    try {
      const res = await agent.send_(thread.id, prompt, [], { headless: true })
      const calls = (await agent.threadState(thread.id).catch(() => null))?.messages.filter((x) => x.role === 'assistant').length ?? 1
      if (res.error || res.aborted) {
        this.recordRun(m.id, false, step, res.error ?? t('修复未完成'), false, calls)
        return { ...failed, repairThreadId: thread.id }
      }
      // what the agent did from the failure on replaces the broken part (with this run's values back as parameters)
      const row = this.lastTrace(thread.id)
      const repairSteps = row ? traceToSteps(json.parse<TraceStep[]>(row.steps) ?? [], { keepStartUrl: true }).steps : []
      const reparam = m.params.filter((p) => values[p.name]).map((p) => ({ ...p, value: values[p.name] }))
      const fixed = applyParams({ steps: repairSteps }, reparam).steps
      if (actionCount(fixed)) {
        const saved = recorder.save({ ...m, steps: splice(m.steps, step, fixed) })
        const version = this.recordVersion(saved, 'repair', t('第 {{v0}} 步失效，由 Agent 修复', { v0: step + 1 }))
        emit('flows.repaired', { macroId: m.id, name: m.name, step: step + 1, version })
      }
      this.recordRun(m.id, true, step, failed.error, true, calls)
      return { ok: true, extracted: failed.extracted, failedStep: step, repaired: true, repairThreadId: thread.id }
    } finally {
      browser.closeTab(tabId)
    }
  }

  private recordRun(macroId: string, ok: boolean, failedStep: number | undefined, error: string | undefined, repaired: boolean, modelCalls: number): void {
    db()
      .prepare('INSERT INTO macro_runs(id, macro_id, at, ok, failed_step, error, repaired, model_calls) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), macroId, Date.now(), ok ? 1 : 0, failedStep ?? null, ok ? null : (error ?? null), repaired ? 1 : 0, modelCalls)
    emit('macros.changed')
  }

  stats(): Record<string, FlowStats> {
    const out: Record<string, FlowStats> = {}
    for (const r of db()
      .prepare(
        'SELECT macro_id, COUNT(*) AS runs, SUM(ok AND NOT repaired) AS ok, SUM(repaired) AS repaired, SUM(NOT ok) AS failed, SUM(model_calls) AS calls, MAX(CASE WHEN repaired THEN at END) AS last FROM macro_runs GROUP BY macro_id',
      )
      .all() as { macro_id: string; runs: number; ok: number; repaired: number; failed: number; calls: number; last: number | null }[])
      out[r.macro_id] = { runs: r.runs, ok: r.ok, repaired: r.repaired, failed: r.failed, modelCalls: r.calls, lastRepairAt: r.last, version: 0 }
    for (const r of db().prepare('SELECT macro_id, MAX(version) AS v FROM macro_versions GROUP BY macro_id').all() as { macro_id: string; v: number }[]) {
      out[r.macro_id] ??= { runs: 0, ok: 0, repaired: 0, failed: 0, modelCalls: 0, lastRepairAt: null, version: 0 }
      out[r.macro_id].version = r.v
    }
    return out
  }
}

export const flows = new Flows()
