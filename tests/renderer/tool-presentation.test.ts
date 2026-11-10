import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('@/lib/ipc', () => ({ call: vi.fn(), on: vi.fn(() => () => {}) }))
import type { ToolCall, UIMessage } from '@shared/types'
import { groupMessages, toolDisplayStatus, toolGroupPreview } from '@/components/chat/message-groups'
import { toolPresentation } from '@/components/chat/tool-meta'
import { ToolCard } from '@/components/chat/tool-card'
import { RuntimeWarning } from '@/components/chat/runtime-warning'
import { MessageList } from '@/components/chat/message-list'
import { runtimeConversationDescription } from '@/components/chat/runtime-description'
import type { AgentRuntimeCapabilities } from '@shared/agent-runtime'

const call = (id: string, status?: NonNullable<ToolCall['activity']>['status']): ToolCall => ({
  id,
  name: 'codex.commandExecution',
  args: { command: `echo ${id}`, cwd: '/workspace', processId: 'private-engine-id' },
  ...(status ? { activity: { kind: 'command', status } } : {}),
})
const assistant = (id: string, content = '', toolCalls?: ToolCall[]): UIMessage => ({ id, role: 'assistant', content, toolCalls })
const result = (id: string, status: 'success' | 'error' = 'success'): UIMessage => ({
  id: `result-${id}`,
  role: 'tool',
  content: 'output',
  toolCallId: id,
  status,
})

describe('tool activity presentation', () => {
  it('uses normalized activity even when the underlying engine name is unknown', () => {
    const display = toolPresentation({
      id: 'call',
      name: 'new_engine.customAction',
      args: { command: 'raw command' },
      activity: { kind: 'command', command: 'rg --files', cwd: '/project' },
    })
    expect(display).toMatchObject({ label: '执行命令', summary: 'rg --files', command: 'rg --files', cwd: '/project' })
    expect(display.summary).not.toContain('raw command')
  })

  it('keeps both legacy and normalized Codex histories readable without vendor JSON labels', () => {
    for (const name of ['codex.commandExecution', 'codex_run_command']) {
      expect(toolPresentation({ ...call('one'), name })).toMatchObject({ label: '执行命令', summary: 'echo one', cwd: '/workspace' })
    }
    expect(toolPresentation({ id: 'f', name: 'vendor.file', args: {}, activity: { kind: 'file_change', paths: ['src/a.ts', 'src/b.ts'] } })).toMatchObject({
      label: '修改文件',
      summary: 'src/a.ts, src/b.ts',
      paths: ['src/a.ts', 'src/b.ts'],
    })
  })

  it('groups adjacent pure tool calls without crossing text, users, reasoning or diagnostics', () => {
    const messages: UIMessage[] = [
      assistant('one', '', [call('one')]),
      result('one'),
      assistant('two', '', [call('two')]),
      result('two'),
      assistant('text', 'I checked the files.'),
      assistant('three', '', [call('three')]),
      { id: 'user', role: 'user', content: 'Continue' },
      assistant('four', '', [call('four')]),
      { ...assistant('thinking'), reasoning: 'Plan next step' },
      assistant('five', '', [call('five')]),
      { ...assistant('warning'), runtimeWarning: 'unexecuted_tool_markup' },
      assistant('six', '', [call('six')]),
    ]
    const blocks = groupMessages(messages)
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'assistant', 'tools', 'user', 'tools', 'assistant', 'tools', 'assistant', 'tools'])
    expect(blocks[0]).toMatchObject({ kind: 'tools', calls: [{ id: 'one' }, { id: 'two' }] })
    expect(messages[0].toolCalls).toHaveLength(1) // grouping must not mutate persisted messages
  })

  it('does not mix subagent and main-agent tool calls', () => {
    const blocks = groupMessages([assistant('a', '', [call('a')]), { ...assistant('s', '', [call('s')]), ns: 'worker' }, assistant('b', '', [call('b')])])
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'sub', 'tools'])
  })

  it('collapses older successful operations but always retains errors, active calls and approvals', () => {
    const calls = Array.from({ length: 9 }, (_, i) => call(String(i)))
    calls[1].activity = { kind: 'command', status: 'pending' }
    calls[2].activity = { kind: 'command', status: 'running' }
    calls[3].activity = { kind: 'command', status: 'cancelled' }
    const results = new Map(['0', '4', '5', '6', '7', '8'].map((id) => [id, result(id, id === '4' ? 'error' : 'success')]))
    const preview = toolGroupPreview(calls, results, true, false)
    expect(preview.visible.map((item) => item.id)).toEqual(['1', '2', '3', '4', '6', '7', '8'])
    expect(preview).toMatchObject({ hiddenCount: 2, failedCount: 1, pendingCount: 1, runningCount: 1, cancelledCount: 1 })
    expect(toolGroupPreview(calls, results, true, true).visible).toEqual(calls)
  })

  it('shows the last three completed operations for long successful runs', () => {
    const calls = Array.from({ length: 12 }, (_, i) => call(String(i)))
    const results = new Map(calls.map((item) => [item.id, result(item.id)]))
    const preview = toolGroupPreview(calls, results, false, false)
    expect(preview.visible.map((item) => item.id)).toEqual(['9', '10', '11'])
    expect(preview.hiddenCount).toBe(9)
  })

  it('never calls a stopped, pending or unknown operation successful', () => {
    expect(toolDisplayStatus(call('one'), undefined, false)).toBe('idle')
    expect(toolDisplayStatus(call('one', 'pending'), undefined, false)).toBe('pending')
    expect(toolDisplayStatus(call('one', 'cancelled'), result('one'), false)).toBe('cancelled')
    expect(toolDisplayStatus(call('one'), { ...result('one'), runtimeWarning: 'tool_outcome_unknown' }, false)).toBe('error')
    expect(toolDisplayStatus(call('one', 'running'), result('one', 'error'), true)).toBe('error')
  })

  it('renders a human-readable command and accessible pending state without dumping protocol fields', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { call: call('one', 'pending'), pending: false, compact: true }))
    expect(html).toContain('执行命令')
    expect(html).toContain('echo one')
    expect(html).toContain('等待确认')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('codex.commandExecution')
    expect(html).not.toContain('private-engine-id')
  })

  it('renders protocol diagnostics as non-executable alerts', () => {
    const html = renderToStaticMarkup(createElement(RuntimeWarning, { warning: 'unexecuted_tool_markup' }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('这些操作没有执行')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<script')
  })

  it('keeps interrupted-result warnings visible even when the cancelled tool details are collapsed', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        call: call('one', 'cancelled'),
        result: { ...result('one', 'error'), runtimeWarning: 'tool_outcome_unknown' },
        pending: false,
      }),
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('已取消')
    expect(html).toContain('role="alert"')
    expect(html).toContain('系统不会自动重试')
  })

  it('describes Navo tool support independently of external model ownership', () => {
    const bridge: AgentRuntimeCapabilities = {
      requiresNavoModel: false,
      navoTools: true,
      approvals: true,
      nativeTools: false,
      images: false,
      resume: true,
      fork: false,
      tokenStreaming: true,
    }
    expect(runtimeConversationDescription(bridge)).toContain('通过 Navo 工具完成任务')
    expect(runtimeConversationDescription(bridge)).toContain('需要确认时会暂停')
    expect(runtimeConversationDescription(bridge)).not.toContain('暂不支持 Navo 工具')
    expect(runtimeConversationDescription({ ...bridge, navoTools: false, approvals: false })).toContain('暂不支持 Navo 工具')
    expect(runtimeConversationDescription()).toContain('正在加载')
  })

  it('renders a long tool-only sequence as one compact group while preserving an earlier failure', () => {
    const messages = Array.from({ length: 10 }, (_, i) => [assistant(`a${i}`, '', [call(String(i))]), result(String(i), i === 1 ? 'error' : 'success')]).flat()
    const html = renderToStaticMarkup(createElement(MessageList, { messages, running: false }))
    expect(html.match(/data-testid="tool-activity-group"/g)).toHaveLength(1)
    expect(html).toContain('展开前 6 项已完成操作')
    expect(html).toContain('echo 1')
    expect(html).toContain('echo 7')
    expect(html).toContain('echo 9')
    expect(html).not.toContain('echo 0')
    expect(html).toContain('1 项失败')
  })
})
