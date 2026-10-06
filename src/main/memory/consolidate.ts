import { z } from 'zod'
import type { Memory } from '@shared/types'
import { findSecret, pairCoverage, similarity } from './recall'

/**
 * Tidying the memory store in the background ("sleep-time" consolidation): memories that say the
 * same thing in different words are merged, a newer memory replaces an older one it contradicts,
 * outdated ones are retired, and contradictions that can't be decided are put to the user.
 * Nothing is deleted: replaced memories are archived and every step can be undone.
 *
 * This file is the pure part: which memories to look at together, the prompt, parsing and the
 * checks a proposed operation has to pass. Applying them lives in memory-service.
 */

export const CONSOLIDATE_MARKER = '你是 Navo 的记忆库管理员'
/** a whole kind is reviewed together up to this size; beyond it only look-alike clusters are */
const WHOLE_GROUP_MAX = 40
const MAX_REVIEWED = 120
/** merged text must be this much backed by its sources (character-pair coverage) */
export const MIN_SUPPORT = 0.7

/** Memories worth looking at together: same kind and site, and either a small group or look-alikes. */
export function reviewGroups(memories: Memory[]): Memory[][] {
  const byScope = new Map<string, Memory[]>()
  for (const m of memories) {
    if (m.status !== 'active') continue
    const k = `${m.kind}|${m.scope ?? ''}`
    byScope.set(k, [...(byScope.get(k) ?? []), m])
  }
  const groups: Memory[][] = []
  for (const list of byScope.values()) {
    if (list.length < 2) continue
    if (list.length <= WHOLE_GROUP_MAX) {
      groups.push(list)
      continue
    }
    // large kind: union look-alikes (loose threshold — the model makes the actual call)
    const parent = list.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (similarity(list[i], list[j]) >= 0.3) parent[find(i)] = find(j)
    const clusters = new Map<number, Memory[]>()
    list.forEach((m, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), m]))
    for (const c of clusters.values()) if (c.length >= 2) groups.push(c)
  }
  // most recently touched groups first, within the overall budget
  groups.sort((a, b) => Math.max(...b.map((m) => m.updatedAt)) - Math.max(...a.map((m) => m.updatedAt)))
  const out: Memory[][] = []
  let n = 0
  for (const g of groups) {
    if (n + g.length > MAX_REVIEWED) continue
    out.push(g)
    n += g.length
  }
  return out
}

const SYSTEM = `${CONSOLIDATE_MARKER}。下面是用户的长期记忆，已按类型分组。找出需要整理的地方，输出要做的操作。大多数记忆不需要动；拿不准就不动。

可用操作：
- merge：几条记忆说的是同一件事（哪怕措辞不同），或者几条零散的可以归纳成一条更完整的。给出合并后的 title 和 content。content 只能使用这几条记忆里已有的信息，不得添加任何新内容或推测。
- supersede：两条互相矛盾，并且能判断哪条是现在的情况（更新时间更晚、或内容本身表明是变化，如「已搬到」「改用」）。保留新的（keep），旧的归档（drop）。
- conflict：两条互相矛盾，但判断不了哪条对。不要猜，用 question 写一句给用户看的问题。
- expire：内容明显已经过期（如已过去的具体日期安排）。

规则：
- 只在同一组内操作；不同主题的记忆不要合并，哪怕类型相同。
- 置顶（pinned）的记忆可以作为合并的一方，但不要 expire 或 drop 它。
- id 使用每条记忆前面给出的 id。reason 用一句话说明原因。

只输出一个 JSON 对象：
{"ops": [
  {"op": "merge", "ids": ["id1", "id2"], "title": "…", "content": "…", "reason": "…"},
  {"op": "supersede", "keep": "id", "drop": "id", "reason": "…"},
  {"op": "conflict", "ids": ["id1", "id2"], "question": "…"},
  {"op": "expire", "id": "id", "reason": "…"}
]}`

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

export function planMessages(groups: Memory[][], today = new Date()): { role: 'system' | 'user'; content: string }[] {
  const body = groups
    .map(
      (g, i) =>
        `## 第 ${i + 1} 组（${g[0].kind}${g[0].scope ? ` · ${g[0].scope}` : ''}）\n` +
        g.map((m) => `- id=${m.id.slice(0, 8)} updated=${day(m.updatedAt)}${m.pinned ? ' pinned' : ''} 「${m.title}」${m.content}`).join('\n'),
    )
    .join('\n\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `今天是 ${day(today.getTime())}。\n\n${body}` },
  ]
}

const id = z.string().min(4)
const reason = z.string().max(300).nullish()
const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('merge'), ids: z.array(id).min(2).max(8), title: z.string().min(1).max(60), content: z.string().min(1).max(1000), reason }),
  z.object({ op: z.literal('supersede'), keep: id, drop: id, reason }),
  z.object({ op: z.literal('conflict'), ids: z.array(id).min(2).max(4), question: z.string().min(1).max(300) }),
  z.object({ op: z.literal('expire'), id, reason }),
])
export type PlanOp = z.infer<typeof Op>

/**
 * Parses the plan and keeps only operations that are safe to apply:
 * ids the model was shown (8-character prefixes resolved), one operation per memory, same kind and
 * site within a merge, pinned memories never dropped, no secrets, and merged text backed by its sources.
 */
export function parsePlan(text: string, reviewed: Memory[]): PlanOp[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const list = (raw as { ops?: unknown })?.ops
  if (!Array.isArray(list)) return []
  const byId = (x: string) => reviewed.find((m) => m.id === x) ?? (x.length >= 6 ? reviewed.find((m) => m.id.startsWith(x)) : undefined)
  const used = new Set<string>()
  const take = (ms: Memory[]) => {
    if (ms.some((m) => used.has(m.id)) || new Set(ms.map((m) => m.id)).size !== ms.length) return false
    ms.forEach((m) => used.add(m.id))
    return true
  }
  const ops: PlanOp[] = []
  for (const item of list.slice(0, 20)) {
    const r = Op.safeParse(item)
    if (!r.success) continue
    const op = r.data
    if (op.op === 'merge') {
      const ms = op.ids.map(byId)
      if (ms.some((m) => !m)) continue
      const src = ms as Memory[]
      if (src.some((m) => m.kind !== src[0].kind || (m.scope ?? null) !== (src[0].scope ?? null))) continue
      if (findSecret(`${op.title}\n${op.content}`)) continue
      if (
        pairCoverage(
          op.content,
          src.map((m) => `${m.title} ${m.content}`),
        ) < MIN_SUPPORT
      )
        continue
      if (take(src)) ops.push({ ...op, ids: src.map((m) => m.id) })
    } else if (op.op === 'supersede') {
      const keep = byId(op.keep)
      const drop = byId(op.drop)
      if (!keep || !drop || keep.id === drop.id || drop.pinned || keep.kind !== drop.kind) continue
      if (take([keep, drop])) ops.push({ ...op, keep: keep.id, drop: drop.id })
    } else if (op.op === 'conflict') {
      const ms = op.ids.map(byId)
      if (ms.some((m) => !m)) continue
      if (take(ms as Memory[])) ops.push({ ...op, ids: (ms as Memory[]).map((m) => m.id) })
    } else {
      const m = byId(op.id)
      if (!m || m.pinned) continue
      if (take([m])) ops.push({ ...op, id: m.id })
    }
  }
  return ops
}

/** In a merge, the memory that lives on (its id stays valid): pinned first, then most used, then oldest. */
export function mergeTarget(sources: Memory[]): Memory {
  return [...sources].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.useCount - a.useCount || a.createdAt - b.createdAt)[0]
}

/** Automatic tidying is due: enough has changed, or a day has passed with a few changes. */
export function consolidationDue(state: { at: number; changes: number }, now = Date.now()): boolean {
  return state.changes >= 10 || (state.changes >= 3 && now - state.at >= 24 * 3600_000)
}
