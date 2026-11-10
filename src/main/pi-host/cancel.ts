import { randomUUID } from 'node:crypto'
import type { UIMessage } from '@shared/types'
import type { PiSnapshot } from './runner'

/** Close unexecuted calls without ever retrying a call whose side effects may have started. */
export function cancelPiPending(state: PiSnapshot): UIMessage[] {
  const messages: UIMessage[] = []
  for (const call of state.pending?.calls ?? []) {
    if (state.messages.some((message) => message.role === 'toolResult' && message.toolCallId === call.id)) continue
    const unknown = state.inFlight === call.id
    const content = unknown
      ? 'Operation stopped while executing. Its outcome is unknown; do not automatically repeat it.'
      : 'Operation cancelled by the user before execution.'
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
  state.pending = null
  // inFlight deliberately survives cancellation: a fresh run must not replay unknown effects.
  return messages
}
