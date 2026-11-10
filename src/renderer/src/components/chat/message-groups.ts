import type { ToolCall, UIMessage } from '@shared/types'

export type MessageBlock<T extends UIMessage = UIMessage> =
  { kind: 'user'; msg: T } | { kind: 'assistant'; msg: T } | { kind: 'tools'; id: string; calls: ToolCall[] } | { kind: 'sub'; ns: string; msgs: T[] }

/** Text, reasoning, diagnostics and user input always interrupt a tool group. */
export function groupMessages<T extends UIMessage>(messages: T[]): MessageBlock<T>[] {
  const blocks: MessageBlock<T>[] = []
  for (const message of messages) {
    if (message.role === 'tool' && !message.ns) continue // paired with its calling card
    const last = blocks.at(-1)
    if (message.ns) {
      if (last?.kind === 'sub' && last.ns === message.ns) last.msgs.push(message)
      else blocks.push({ kind: 'sub', ns: message.ns, msgs: [message] })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls?.length && !message.content.trim() && !message.reasoning && !message.runtimeWarning) {
      if (last?.kind === 'tools') last.calls.push(...message.toolCalls)
      else blocks.push({ kind: 'tools', id: message.id, calls: [...message.toolCalls] })
      continue
    }
    blocks.push(message.role === 'user' ? { kind: 'user', msg: message } : { kind: 'assistant', msg: message })
  }
  return blocks
}

export type ToolDisplayStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'idle'

export function toolDisplayStatus(call: ToolCall, result: UIMessage | undefined, running: boolean): ToolDisplayStatus {
  if (call.activity?.status === 'cancelled') return 'cancelled'
  if (result) return result.status === 'error' || result.runtimeWarning ? 'error' : 'success'
  return call.activity?.status ?? (running ? 'running' : 'idle')
}

/** Collapsing old successes must never hide failed, pending or interrupted operations. */
export function toolGroupPreview(calls: ToolCall[], results: ReadonlyMap<string, UIMessage>, running: boolean, expanded: boolean) {
  const statuses = calls.map((call) => toolDisplayStatus(call, results.get(call.id), running))
  const visible = calls.filter((_, index) => expanded || index >= calls.length - 3 || statuses[index] !== 'success')
  return {
    visible,
    hiddenCount: calls.length - visible.length,
    failedCount: statuses.filter((status) => status === 'error').length,
    runningCount: statuses.filter((status) => status === 'running').length,
    pendingCount: statuses.filter((status) => status === 'pending').length,
    cancelledCount: statuses.filter((status) => status === 'cancelled').length,
  }
}
