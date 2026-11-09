import { randomUUID } from 'node:crypto'
import {
  runAgentLoop,
  runAgentLoopContinue,
  runToolCall,
  type AgentMessage,
  type AgentTool,
  type AgentEvent,
  type StreamFn,
  type AgentToolCall,
} from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ChatEvent, PendingInterrupt, ThreadState, UIMessage } from '@shared/types'
import type { RunRequest, RunResult, RuntimeModel, ToolCallRequest, UsageEvent } from '../agent-runtime/contracts'
import { piModelAdapter } from './model'

interface Pending {
  assistant: AssistantMessage
  calls: AgentToolCall[]
  approved: boolean
  interrupt: PendingInterrupt
}
export interface PiSnapshot {
  messages: AgentMessage[]
  ui: UIMessage[]
  pending: Pending | null
  inFlight: string | null
}
export interface PiRunnerDeps {
  read(id: string): PiSnapshot | null
  write(id: string, state: PiSnapshot): void
  remove(id: string): void
  list(): string[]
  emit(event: ChatEvent): void
  callTool(request: ToolCallRequest): Promise<unknown>
  usage(event: UsageEvent): void
  stream?(model: RuntimeModel): StreamFn
}
class Pause extends Error {}
export class PiRunner {
  private active = new Map<string, AbortController>()
  constructor(private deps: PiRunnerDeps) {}
  abort(threadId: string): void {
    this.active.get(threadId)?.abort()
  }
  state(threadId: string): Omit<ThreadState, 'running'> {
    const s = this.deps.read(threadId)
    return { messages: s?.ui ?? [], todos: [], interrupt: s?.pending?.interrupt ?? null }
  }
  pendingApprovals() {
    return this.deps.list().flatMap((threadId) => {
      const interrupt = this.deps.read(threadId)?.pending?.interrupt
      return interrupt ? [{ threadId, interrupt }] : []
    })
  }
  deleteThread(threadId: string): void {
    if (this.active.has(threadId)) throw new Error('Pi conversation is still running')
    this.deps.remove(threadId)
  }
  async run(req: RunRequest): Promise<RunResult> {
    if (this.active.has(req.threadId)) throw new Error('Pi conversation is already running')
    if (req.fromCheckpointId) throw new Error('Pi historical regeneration is not supported')
    const state = this.deps.read(req.threadId) ?? { messages: [], ui: [], pending: null, inFlight: null }
    if (state.inFlight) throw new Error('A Pi tool outcome is unknown after interruption; it will not be executed again automatically')
    if (!state.messages.some((message) => message.role === 'system')) {
      state.messages.unshift({ role: 'system', content: req.systemPrompt, timestamp: Date.now() })
      this.deps.write(req.threadId, state)
    }
    const controller = new AbortController()
    this.active.set(req.threadId, controller)
    const save = () => this.deps.write(req.threadId, state)
    const ui = (message: UIMessage) => {
      const index = state.ui.findIndex((m) => m.id === message.id)
      if (index < 0) state.ui.push(message)
      else state.ui[index] = message
      save()
      this.deps.emit({ type: 'message', threadId: req.threadId, message })
    }
    const tools: AgentTool[] = req.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.schema,
      executionMode: 'sequential',
      execute: async (callId, args) => {
        if (controller.signal.aborted) throw new Error('Pi run cancelled')
        state.inFlight = callId
        save()
        const value = await this.deps.callTool({ runId: req.runId, threadId: req.threadId, name: tool.name, args: args as Record<string, unknown> })
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} }
      },
    }))
    let finalText = ''
    let messageId = ''
    let error: string | undefined
    const emit = async (event: AgentEvent): Promise<void> => {
      if (event.type === 'message_start' && event.message.role === 'assistant') messageId = randomUUID()
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
        this.deps.emit({ type: 'token', threadId: req.threadId, messageId, text: event.assistantMessageEvent.delta })
      if (event.type !== 'message_end') return
      const message = event.message
      state.messages.push(structuredClone(message))
      if (message.role === 'assistant') {
        finalText = message.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
        const calls = message.content.filter((c) => c.type === 'toolCall')
        ui({
          id: messageId || randomUUID(),
          role: 'assistant',
          content: finalText,
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.arguments })),
        })
        this.deps.usage({
          threadId: req.threadId,
          modelId: req.model.id,
          model: req.model.model,
          usage: {
            input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
            output: message.usage.output,
            cached: message.usage.cacheRead,
          },
        })
        if (message.stopReason === 'error') error = message.errorMessage ?? 'Pi model request failed'
        if (calls.length && message.stopReason !== 'error' && message.stopReason !== 'aborted' && message.stopReason !== 'length') {
          const interrupt: PendingInterrupt = {
            id: randomUUID(),
            actionRequests: calls.map((c) => ({ name: c.name, args: c.arguments, description: c.name })),
            allowedDecisions: calls.map(() => ['approve', 'edit', 'reject']),
          }
          state.pending = {
            assistant: structuredClone(message),
            calls: structuredClone(calls),
            approved: !calls.some((c) => req.interruptOn.includes(c.name)),
            interrupt,
          }
          save()
          throw new Pause()
        }
      } else if (message.role === 'toolResult') {
        state.inFlight = null
        ui({
          id: randomUUID(),
          role: 'tool',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
          status: message.isError ? 'error' : 'success',
        })
      }
      save()
    }
    const config = {
      model: piModelAdapter.model(req.model),
      convertToLlm: (messages: AgentMessage[]) => messages as Message[],
      toolExecution: 'sequential' as const,
    }
    const stream = (this.deps.stream ?? piModelAdapter.stream)(req.model)
    const executePending = async () => {
      const pending = state.pending!
      for (const call of pending.calls) {
        if (state.messages.some((m) => m.role === 'toolResult' && m.toolCallId === call.id)) continue
        if (controller.signal.aborted) throw new Error('Pi run cancelled')
        const outcome = await runToolCall(call, {
          tools,
          assistantMessage: pending.assistant,
          context: { messages: state.messages, tools },
          signal: controller.signal,
        })
        const result: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: outcome.result.content,
          isError: outcome.isError,
          timestamp: Date.now(),
        }
        await emit({ type: 'message_end', message: result })
      }
      state.pending = null
      save()
    }
    try {
      if (req.input.kind === 'resume') {
        if (!state.pending || state.pending.approved) throw new Error('Pi approval is no longer pending')
        if (req.input.decisions.length !== state.pending.calls.length) throw new Error('Pi approval decision count does not match')
        for (const [i, decision] of req.input.decisions.entries()) {
          const call = state.pending.calls[i]
          if (decision.type === 'edit') {
            if (decision.editedAction.name !== call.name) throw new Error('Pi approval cannot change the tool name')
            call.arguments = decision.editedAction.args as AgentToolCall['arguments']
          } else if (decision.type === 'reject')
            await emit({
              type: 'message_end',
              message: {
                role: 'toolResult',
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: 'text', text: decision.message ?? 'User rejected this operation' }],
                isError: true,
                timestamp: Date.now(),
              },
            })
        }
        state.pending.approved = true
        save()
      } else {
        if (state.pending) throw new Error('Resolve the pending Pi tool batch before sending another message')
        ui({ id: req.input.id, role: 'user', content: req.input.text, attachments: req.input.attachments })
        const text = [req.input.text, req.input.context].filter(Boolean).join('\n\n')
        const messages: AgentMessage[] = [{ role: 'user', content: text, timestamp: Date.now() }]
        try {
          await runAgentLoop(messages, { messages: [...state.messages], tools }, config, emit, controller.signal, stream)
        } catch (e) {
          if (!(e instanceof Pause)) throw e
        }
      }
      while (state.pending) {
        if (!state.pending.approved) {
          this.deps.emit({ type: 'interrupt', threadId: req.threadId, interrupt: state.pending.interrupt })
          return { finalText, interrupted: true }
        }
        await executePending()
        try {
          await runAgentLoopContinue({ messages: [...state.messages], tools }, config, emit, controller.signal, stream)
        } catch (e) {
          if (!(e instanceof Pause)) throw e
        }
      }
      return { finalText, interrupted: false, ...(error ? { error } : {}), ...(controller.signal.aborted ? { aborted: true } : {}) }
    } finally {
      save()
      this.active.delete(req.threadId)
    }
  }
}
