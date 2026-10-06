import { create } from 'zustand'
import { toast } from 'sonner'
import type { Memory, MemoryKind } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

export const KIND_LABEL: Record<MemoryKind, string> = { profile: '关于我', preference: '偏好', knowledge: '知识', site: '站点经验' }
export const KIND_HINT: Record<MemoryKind, string> = {
  profile: '你是谁：称呼、职业、所在城市、常用语言',
  preference: '希望 Navo 怎么做事：回答风格、格式、习惯，以及你纠正过它的地方',
  knowledge: '长期相关的项目、人、约定和背景',
  site: '在某个网站上可复用的操作经验，打开该网站时自动提示',
}

interface MemoryStore {
  items: Memory[] | null
  error: string | null
  load: () => Promise<void>
}

export const useMemories = create<MemoryStore>((set) => ({
  items: null,
  error: null,
  load: async () => {
    try {
      set({ items: await call('memory.list'), error: null })
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },
}))

let wired = false
export function wireMemoryEvents(): void {
  if (wired) return
  wired = true
  on('memory.changed', () => {
    if (useMemories.getState().items) void useMemories.getState().load()
  })
  on('memory.consolidated', ({ changed, conflicts }) => {
    toast(conflicts && !changed ? '发现互相矛盾的记忆' : `整理了 ${changed} 条记忆`, {
      description: conflicts ? `有 ${conflicts} 处矛盾需要你确认` : '合并了重复的、更新了过时的，可以在整理记录里撤销',
      action: { label: '查看', onClick: () => (window.location.hash = conflicts ? '#/memory' : '#/memory?filter=merges') },
    })
  })
  // automatic learning after a reply: say what was remembered, with a way back
  on('memory.learned', (l) => {
    const names = l.items.map((i) => `「${i.title}」`).join('、')
    if (l.pending) {
      toast('有新的记忆待确认', {
        description: names,
        action: { label: '去确认', onClick: () => (window.location.hash = '#/memory?filter=pending') },
      })
      return
    }
    const held = l.items.filter((i) => i.pending)
    const done = l.items.filter((i) => !i.pending)
    const verb = done.every((i) => i.op === 'delete') ? '已忘记' : done.every((i) => i.op === 'update') ? '已更新记忆' : '已记住'
    toast(verb, {
      description: held.length ? `${done.map((i) => `「${i.title}」`).join('、')}；另有 ${held.length} 条不是你亲口说的，需要你确认` : names,
      action: {
        label: '撤销',
        onClick: () =>
          void call('memory.undo', l.batchId).then(
            () => toast.success('已撤销'),
            (e) => toast.error('撤销失败', { description: errorMessage(e) }),
          ),
      },
    })
  })
}
