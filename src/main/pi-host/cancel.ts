import { randomUUID } from 'node:crypto'
import type { UIMessage } from '@shared/types'
import type { PiSnapshot } from './runner'

function closeCalls(state: PiSnapshot, calls: { id: string; name: string }[], cancelled: boolean): UIMessage[] {
  const messages: UIMessage[] = []
  for (const call of calls) {
    if (state.messages.some((message) => message.role === 'toolResult' && message.toolCallId === call.id)) continue
    const unknown = state.inFlight === call.id
    const content = unknown
      ? 'Operation stopped while executing. Its outcome is unknown; do not automatically repeat it.'
      : cancelled
        ? 'Operation cancelled by the user before execution.'
        : 'Operation was not executed because the previous run was interrupted.'
    state.messages.push({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: content }],
      isError: true,
      timestamp: Date.now(),
    })
    const message: UIMessage = {
      id: randomUUID(),
      role: 'tool',
      toolCallId: call.id,
      toolName: call.name,
      content,
      status: 'error',
      ...(unknown ? { runtimeWarning: 'tool_outcome_unknown' } : {}),
    }
    state.ui.push(message)
    messages.push(message)
  }
  return messages
}

/** Close unexecuted calls without ever retrying a call whose side effects may have started. */
export function cancelPiPending(state: PiSnapshot): UIMessage[] {
  const messages = closeCalls(state, state.pending?.calls ?? [], true)
  state.pending = null
  // inFlight deliberately survives cancellation: a fresh run must not replay unknown effects.
  return messages
}

/** Explicit recovery closes old calls; it never resumes their execution. */
export function recoverPiInterruption(state: PiSnapshot): UIMessage[] {
  if (!state.inFlight) return []
  const id = state.inFlight
  const completed = state.messages.some((message) => message.role === 'toolResult' && message.toolCallId === id)
  const calls = [...(state.pending?.calls ?? [])]
  const assistant = state.messages.findLast(
    (message) => message.role === 'assistant' && message.content.some((block) => block.type === 'toolCall' && block.id === id),
  )
  if (assistant?.role === 'assistant')
    for (const block of assistant.content) if (block.type === 'toolCall' && !calls.some((call) => call.id === block.id)) calls.push(block)
  if (!completed && !calls.some((call) => call.id === id))
    throw new Error('The interrupted Pi tool call could not be identified; its outcome cannot be recovered safely')
  const messages = closeCalls(state, calls, false)
  state.pending = null
  state.inFlight = null
  return messages
}
