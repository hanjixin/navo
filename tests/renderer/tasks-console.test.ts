import { describe, expect, it, vi } from 'vitest'
vi.mock('@shared/i18n', () => ({ t: (value: string) => value }))
import { taskRunTimeline } from '@/components/tasks/run-timeline'

describe('task run console timeline', () => {
  it('shows approval before completion', () => {
    expect(taskRunTimeline('waiting_approval', true).map((step) => step.label)).toEqual(['已创建', '已启动', '等待确认', '完成'])
  })
  it('ends with a concrete terminal state', () => {
    expect(taskRunTimeline('error', false).at(-1)).toEqual({ label: '失败', done: true })
    expect(taskRunTimeline('cancelled', false).at(-1)).toEqual({ label: '已取消', done: true })
  })
})
