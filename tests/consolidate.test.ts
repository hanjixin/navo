import { describe, expect, it } from 'vitest'
import type { Memory } from '../src/shared/types'
import { consolidationDue, mergeTarget, parsePlan, planMessages, reviewGroups } from '../src/main/memory/consolidate'
import { pairCoverage } from '../src/main/memory/recall'

let n = 0
const mem = (over: Partial<Memory>): Memory => ({
  id: `${String(++n).padStart(8, '0')}-aaaa-bbbb-cccc-000000000000`,
  kind: 'preference',
  title: '',
  content: '',
  scope: null,
  status: 'active',
  pinned: false,
  source: null,
  createdAt: n,
  updatedAt: n,
  lastUsedAt: null,
  useCount: 0,
  ...over,
})

const a = mem({ title: '回答风格', content: '用户希望回答先给结论。' })
const b = mem({ title: '结论优先', content: '说明问题时请把结论放在最前面，再展开细节。' })
const hz = mem({ kind: 'profile', title: '所在城市', content: '用户在杭州工作。' })
const sh = mem({ kind: 'profile', title: '工作城市', content: '用户已搬到上海工作。' })
const pinned = mem({ kind: 'profile', title: '称呼', content: '用户叫小韩。', pinned: true })
const site = mem({ kind: 'site', scope: 'jd.com', title: '搜索', content: '先关登录弹窗。' })
const all = [a, b, hz, sh, pinned, site]
const plan = (ops: unknown[]) => JSON.stringify({ ops })

describe('reviewGroups', () => {
  it('groups by kind and site; singletons and inactive memories are left out', () => {
    const groups = reviewGroups([...all, mem({ title: '待确认', content: 'x', status: 'pending' }), mem({ title: '已归档', content: 'y', status: 'archived' })])
    expect(groups.map((g) => g.map((m) => m.title).sort())).toEqual(
      expect.arrayContaining([
        ['回答风格', '结论优先'],
        ['工作城市', '所在城市', '称呼'],
      ]),
    )
    expect(groups.flat().some((m) => m.kind === 'site' || m.status !== 'active')).toBe(false)
  })
  it('a large kind is reduced to look-alike clusters', () => {
    // 50 memories with no words in common (each uses its own run of characters)
    const many = Array.from({ length: 50 }, (_, i) =>
      mem({ kind: 'knowledge', title: `t${i}`, content: Array.from({ length: 12 }, (_, k) => String.fromCharCode(0x4e00 + i * 40 + k)).join('') }),
    )
    const twinA = mem({ kind: 'knowledge', title: '周报', content: '周报每周五下午五点前交给王经理。' })
    const twinB = mem({ kind: 'knowledge', title: '周报时间', content: '周报每周五下午五点前要交给王经理。' })
    const groups = reviewGroups([...many, twinA, twinB])
    expect(groups.some((g) => g.includes(twinA) && g.includes(twinB))).toBe(true)
    expect(groups.flat().length).toBeLessThan(52)
  })
})

describe('planMessages', () => {
  it('shows short ids, dates and pins', () => {
    const text = planMessages(
      [
        [a, b],
        [hz, sh, pinned],
      ],
      new Date('2026-10-06'),
    )[1].content
    expect(text).toContain(`id=${a.id.slice(0, 8)}`)
    expect(text).toContain('今天是 2026-10-06')
    expect(text).toMatch(/pinned 「称呼」/)
  })
})

describe('parsePlan', () => {
  it('accepts a merge whose text is backed by its sources; resolves short ids', () => {
    const ops = parsePlan(
      plan([
        {
          op: 'merge',
          ids: [a.id.slice(0, 8), b.id.slice(0, 8)],
          title: '回答风格',
          content: '用户希望回答先给结论，把结论放在最前面，再展开细节。',
          reason: '同一偏好',
        },
      ]),
      all,
    )
    expect(ops).toEqual([expect.objectContaining({ op: 'merge', ids: [a.id, b.id] })])
  })
  it('rejects a merge that adds things the sources never said', () => {
    expect(parsePlan(plan([{ op: 'merge', ids: [a.id, b.id], title: '回答风格', content: '用户在腾讯担任首席架构师，喜欢简短回答。' }]), all)).toEqual([])
  })
  it('rejects merging across kinds or sites, unknown ids, and secrets', () => {
    expect(parsePlan(plan([{ op: 'merge', ids: [a.id, hz.id], title: 'x', content: '用户希望回答先给结论。用户在杭州工作。' }]), all)).toEqual([])
    expect(parsePlan(plan([{ op: 'merge', ids: [a.id, 'ffffffff'], title: 'x', content: '用户希望回答先给结论。' }]), all)).toEqual([])
    const s1 = mem({ title: '甲', content: '密码是 hunter2024 的那个账号' })
    const s2 = mem({ title: '乙', content: '账号' })
    expect(parsePlan(plan([{ op: 'merge', ids: [s1.id, s2.id], title: '账号', content: '密码是 hunter2024 的那个账号' }]), [s1, s2])).toEqual([])
  })
  it('supersede: needs two known memories of one kind and never drops a pinned one', () => {
    expect(parsePlan(plan([{ op: 'supersede', keep: sh.id, drop: hz.id, reason: '已搬家' }]), all)).toEqual([
      expect.objectContaining({ op: 'supersede', keep: sh.id, drop: hz.id }),
    ])
    expect(parsePlan(plan([{ op: 'supersede', keep: sh.id, drop: pinned.id }]), all)).toEqual([])
    expect(parsePlan(plan([{ op: 'supersede', keep: sh.id, drop: a.id }]), all)).toEqual([])
    expect(parsePlan(plan([{ op: 'supersede', keep: sh.id, drop: sh.id }]), all)).toEqual([])
  })
  it('expire never touches a pinned memory; conflict needs two memories', () => {
    expect(
      parsePlan(
        plan([
          { op: 'expire', id: pinned.id },
          { op: 'expire', id: hz.id, reason: '过期' },
        ]),
        all,
      ),
    ).toEqual([expect.objectContaining({ op: 'expire', id: hz.id })])
    expect(parsePlan(plan([{ op: 'conflict', ids: [hz.id, sh.id], question: '你现在在哪个城市？' }]), all)).toHaveLength(1)
    expect(parsePlan(plan([{ op: 'conflict', ids: [hz.id], question: '?' }]), all)).toEqual([])
  })
  it('one operation per memory; garbage is ignored', () => {
    const ops = parsePlan(plan([{ op: 'supersede', keep: sh.id, drop: hz.id }, { op: 'expire', id: hz.id }, { op: 'nonsense' }]), all)
    expect(ops).toHaveLength(1)
    expect(parsePlan('not json', all)).toEqual([])
    expect(parsePlan('{"ops":"none"}', all)).toEqual([])
  })
})

describe('helpers', () => {
  it('mergeTarget keeps the pinned, then most used, then oldest memory', () => {
    const old = mem({ title: 'o', createdAt: 1 })
    const used = mem({ title: 'u', createdAt: 5, useCount: 9 })
    const pin = mem({ title: 'p', createdAt: 9, pinned: true })
    expect(mergeTarget([old, used]).title).toBe('u')
    expect(mergeTarget([old, used, pin]).title).toBe('p')
    expect(mergeTarget([mem({ title: 'new', createdAt: 9 }), old]).title).toBe('o')
  })
  it('consolidationDue: ten changes, or a day with at least three', () => {
    const now = 100 * 24 * 3600_000
    expect(consolidationDue({ at: now - 1000, changes: 10 }, now)).toBe(true)
    expect(consolidationDue({ at: now - 1000, changes: 9 }, now)).toBe(false)
    expect(consolidationDue({ at: now - 25 * 3600_000, changes: 3 }, now)).toBe(true)
    expect(consolidationDue({ at: now - 25 * 3600_000, changes: 2 }, now)).toBe(false)
  })
  it('pairCoverage measures how much of a text its sources back', () => {
    expect(pairCoverage('用户希望回答先给结论', ['用户希望回答先给结论。'])).toBe(1)
    expect(pairCoverage('完全无关的另一句话', ['用户希望回答先给结论。'])).toBeLessThan(0.2)
  })
})
