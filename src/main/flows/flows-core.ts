import { z } from 'zod'
import type { MacroParam, MacroStep } from '@shared/types'
import { appendEvent } from '../recorder/steps'
import type { TraceStep } from './trace'
import { t } from '@shared/i18n'

/**
 * Fixed flows — the pure part. What the agent worked out with the model on an (often old,
 * hard-to-automate) system becomes a list of steps with stable selectors that replays without the
 * model; values that change from run to run become parameters.
 */

export const FLOW_MARKER = '你是 Navo 的流程整理员'
/** a trace needs at least this many actions to be worth keeping as a flow */
export const MIN_FLOW_ACTIONS = 2

const GENERIC = /^[a-z][a-z0-9]*$/i

/** Turns an agent trace into replayable steps: the first page becomes the start URL. */
export function traceToSteps(trace: TraceStep[], opts: { keepStartUrl?: boolean } = {}): { startUrl?: string; steps: MacroStep[] } {
  let startUrl: string | undefined
  let steps: MacroStep[] = []
  let lastActionAt = 0
  for (const t of trace) {
    // a repair continues where the flow stopped: its first navigation is a step, not the start
    if (t.type === 'navigate' && !startUrl && !steps.length && !opts.keepStartUrl) {
      startUrl = t.url
      continue
    }
    // the agent's navigations are deliberate (unlike a recorder's, which follow clicks): keep them
    steps = appendEvent(steps, { ...t, t: t.type === 'navigate' ? Number.MAX_SAFE_INTEGER : t.at }, t.type === 'navigate' ? 0 : lastActionAt)
    if (t.type !== 'navigate') lastActionAt = t.at
  }
  // a bare tag ("button") was unique on that page but would match the wrong element on the next one
  // (or the previous one, while it is still loading): only selectors that say which element count
  steps = steps.map((s) => (s.selectors ? { ...s, selectors: s.selectors.filter((sel) => !GENERIC.test(sel)) } : s))
  // clicks / typing without anything to find the element by can't be replayed
  steps = steps.filter((s) => s.type === 'navigate' || s.type === 'press' || !!s.selectors?.length)
  return { startUrl, steps }
}

export const actionCount = (steps: MacroStep[]) => steps.filter((s) => s.type !== 'navigate').length

/** Values typed or chosen during the run — the candidates for parameters (passwords excluded). */
export function typedValues(steps: MacroStep[]): string[] {
  return [...new Set(steps.filter((s) => (s.type === 'type' || s.type === 'select') && s.value && !/\{\{/.test(s.value)).map((s) => s.value!))]
}

/** Replaces the chosen values by {{name}} placeholders (also inside URLs, e.g. search queries). */
export function applyParams(
  flow: { startUrl?: string; steps: MacroStep[] },
  params: (MacroParam & { value: string })[],
): { startUrl?: string; steps: MacroStep[] } {
  const swap = (text: string | undefined) => {
    if (!text) return text
    let out = text
    for (const p of params) {
      if (!p.value) continue
      out = out.split(p.value).join(`{{${p.name}}}`)
      const enc = encodeURIComponent(p.value)
      if (enc !== p.value) out = out.split(enc).join(`{{${p.name}}}`)
    }
    return out
  }
  return {
    startUrl: swap(flow.startUrl),
    steps: flow.steps.map((s) => ({ ...s, value: s.type === 'type' || s.type === 'select' ? swap(s.value) : s.value, url: swap(s.url) })),
  }
}

/** After a repair: the steps that worked up to the failure, then what the agent did from there. */
export function splice(steps: MacroStep[], failedStep: number, repair: MacroStep[]): MacroStep[] {
  return [...steps.slice(0, Math.max(0, failedStep)), ...repair]
}

/** One line per step, for people and for the repair prompt. */
export function describeStep(s: MacroStep): string {
  const what = s.label ? `「${s.label}」` : (s.selectors?.[0] ?? '')
  switch (s.type) {
    case 'navigate':
      return t('打开 {{v0}}', { v0: s.url })
    case 'click':
      return t('点击 {{v0}}', { v0: what })
    case 'type':
      return t('在 {{v0}} 输入 {{v1}}', { v0: what, v1: s.value ?? '' })
    case 'select':
      return t('在 {{v0}} 选择 {{v1}}', { v0: what, v1: s.value ?? '' })
    case 'press':
      return t('按 {{v0}}', { v0: s.key ?? 'Enter' })
    case 'wait':
      return t('等待 {{v0}}', { v0: what || `${s.value}ms` })
    case 'scroll':
      return t('向下滚动')
    default:
      return t('提取 {{v0}} 的文本', { v0: what || t('页面') })
  }
}

// ---------- naming and parameters (one model call)

export function flowMessages(userText: string, steps: MacroStep[]): { role: 'system' | 'user'; content: string }[] {
  const values = typedValues(steps)
  return [
    {
      role: 'system',
      content: `${FLOW_MARKER}。用户让 Agent 在某个系统上完成了一次操作，下面是操作步骤。要把它保存成以后可以直接回放的固定流程。
请给出：
- name：流程名称，不超过 16 个字。
- description：一句话说明这个流程做什么、什么时候用。
- params：哪些输入值是每次执行都会变的（如单号、日期、金额、搜索词），把它们设为参数。name 用英文小写和下划线（如 order_no），description 用中文说明，value 必须是下面「输入过的值」里原样出现的一个。账号、固定选项这类每次都一样的值不要设为参数。

只输出一个 JSON 对象：{"name": "…", "description": "…", "params": [{"name": "order_no", "description": "订单号", "value": "…"}]}`,
    },
    {
      role: 'user',
      content: `## 用户的要求\n${userText.slice(0, 2000)}\n\n## 操作步骤\n${steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n')}\n\n## 输入过的值\n${values.length ? values.map((v) => `- ${v}`).join('\n') : '（无）'}`,
    },
  ]
}

const Meta = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(300).nullish(),
  params: z
    .array(z.object({ name: z.string().min(1).max(40), description: z.string().max(100).nullish(), value: z.string() }))
    .max(10)
    .nullish(),
})

/** The model's naming / parameter proposal; parameters must name values that were actually typed. */
export function parseFlowMeta(
  text: string,
  steps: MacroStep[],
  fallbackName: string,
): { name: string; description: string; params: (MacroParam & { value: string })[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let meta: z.infer<typeof Meta> | null = null
  try {
    if (start >= 0 && end > start) meta = Meta.parse(JSON.parse(text.slice(start, end + 1)))
  } catch {
    meta = null
  }
  const values = new Set(typedValues(steps))
  const seen = new Set<string>()
  const params = (meta?.params ?? [])
    .map((p) => ({
      ...p,
      name: p.name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, ''),
    }))
    .filter((p) => p.name && values.has(p.value) && !seen.has(p.name) && seen.add(p.name))
    .map((p) => ({ name: p.name, description: p.description ?? undefined, default: p.value, value: p.value }))
  return { name: meta?.name?.trim() || fallbackName, description: meta?.description?.trim() ?? '', params }
}

/**
 * When the model proposes no parameters (or couldn't be asked): values typed during the run that the
 * user gave in the request itself — an order number, a date, a keyword — are the ones that change.
 */
export function fallbackParams(userText: string, steps: MacroStep[]): (MacroParam & { value: string })[] {
  return typedValues(steps)
    .filter((v) => v.length >= 2 && userText.includes(v))
    .slice(0, 5)
    .map((v, i) => ({ name: `value_${i + 1}`, description: `本次输入的「${v.slice(0, 20)}」`, default: v, value: v }))
}

const REPEAT = /每天|每周|每月|每次|以后|今后|定期|经常|又要|再帮我|批量|每个|每一|老规矩|照旧|daily|weekly|every|again|routine/i
/** The user's words suggest this will be done again: worth offering to keep it as a fixed flow. */
export const soundsRepeated = (text: string) => REPEAT.test(text)
