import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LearningScheduler, MAX_PENDING_TURNS, type LearnTurn } from '../src/main/learning/scheduler'
import { hasMemorySignal } from '../src/main/memory/recall'

const turn = (userText: string): LearnTurn => ({
  userText,
  reply: '好的。',
  actions: [],
  journalOnly: false,
  at: 0,
  filesRead: [],
  toolCalls: 0,
  toolErrors: 0,
})

function setup(saved: Record<string, LearnTurn[]> = {}) {
  const flushed: { threadId: string; texts: string[]; reason: string }[] = []
  const disk = new Map(Object.entries(saved))
  const s = new LearningScheduler({
    idleMs: () => 1000,
    flush: async (threadId, turns, reason) => void flushed.push({ threadId, texts: turns.map((t) => t.userText), reason }),
    store: { load: () => Object.fromEntries(disk), save: (id, t) => void disk.set(id, t), clear: (id) => void disk.delete(id) },
  })
  return { s, flushed, disk }
}

describe('hasMemorySignal', () => {
  it('explicit requests, corrections, standing preferences and facts about the user', () => {
    for (const t of [
      '记住，周报周五交',
      '以后回答先给结论',
      '不对，我用的是 Mac',
      '我叫小韩',
      '我已经搬到上海了',
      '忘掉我喜欢表格这件事吧',
      '从现在开始用英文',
      'Remember that I prefer tabs',
      "I'm a designer",
    ])
      expect(hasMemorySignal(t), t).toBe(true)
  })
  it('ordinary requests wait for the idle pass', () => {
    for (const t of ['帮我在京东搜一下 AirPods 的价格', '把这句翻译成英文：我们下周三开会', '这个网页讲了什么？', '用 JS 写个快速排序', '总结一下这篇文章'])
      expect(hasMemorySignal(t), t).toBe(false)
  })
})

describe('LearningScheduler', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('a cue is processed at once, together with what was already waiting', async () => {
    const { s, flushed } = setup()
    s.submit('a', turn('帮我查一下航班'))
    expect(flushed).toEqual([])
    s.submit('a', turn('记住我只坐靠窗的位置'))
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toEqual([{ threadId: 'a', texts: ['帮我查一下航班', '记住我只坐靠窗的位置'], reason: 'signal' }])
  })

  it('ordinary turns wait until the conversation is quiet; each new turn restarts the wait', async () => {
    const { s, flushed } = setup()
    s.submit('a', turn('帮我查一下航班'))
    await vi.advanceTimersByTimeAsync(800)
    s.submit('a', turn('换成下午的'))
    await vi.advanceTimersByTimeAsync(800)
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    expect(flushed).toEqual([{ threadId: 'a', texts: ['帮我查一下航班', '换成下午的'], reason: 'idle' }])
  })

  it('enough turns are processed without waiting', async () => {
    const { s, flushed } = setup()
    for (let i = 0; i < MAX_PENDING_TURNS; i++) s.submit('a', turn(`查询 ${i}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toHaveLength(1)
    expect(flushed[0].reason).toBe('count')
    expect(flushed[0].texts).toHaveLength(MAX_PENDING_TURNS)
  })

  it('moving to another conversation processes the one left behind', async () => {
    const { s, flushed } = setup()
    s.submit('a', turn('帮我查一下航班'))
    s.submit('b', turn('写个排序'))
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toEqual([{ threadId: 'a', texts: ['帮我查一下航班'], reason: 'switch' }])
  })

  it('pending turns survive a restart and are forgotten only after they were processed', async () => {
    const first = setup()
    first.s.submit('a', turn('帮我查一下航班'))
    expect(first.disk.get('a')).toHaveLength(1)
    // "restart": a new scheduler over the same storage
    const second = setup(Object.fromEntries(first.disk))
    second.s.resume()
    await vi.advanceTimersByTimeAsync(6000)
    expect(second.flushed).toEqual([{ threadId: 'a', texts: ['帮我查一下航班'], reason: 'resume' }])
    expect(second.disk.has('a')).toBe(false)
  })

  it('a deleted conversation is dropped', async () => {
    const { s, flushed, disk } = setup()
    s.submit('a', turn('帮我查一下航班'))
    s.drop('a')
    await vi.advanceTimersByTimeAsync(5000)
    expect(flushed).toEqual([])
    expect(disk.has('a')).toBe(false)
  })

  it('turns arriving during a pass are kept for the next one', async () => {
    let release = () => {}
    const seen: string[][] = []
    const disk = new Map<string, LearnTurn[]>()
    const s = new LearningScheduler({
      idleMs: () => 1000,
      flush: (_id, turns) => {
        seen.push(turns.map((t) => t.userText))
        return seen.length === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve()
      },
      store: { load: () => ({}), save: (id, t) => void disk.set(id, t), clear: (id) => void disk.delete(id) },
    })
    s.submit('a', turn('记住 A'))
    await vi.advanceTimersByTimeAsync(0)
    s.submit('a', turn('普通的一句'))
    expect(disk.get('a')).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(1100)
    expect(seen).toEqual([['记住 A'], ['普通的一句']])
    expect(disk.has('a')).toBe(false)
  })
})
