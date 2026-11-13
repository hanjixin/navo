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
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ChatEvent, PendingInterrupt, ThreadState, UIMessage } from '@shared/types'
import type { RunRequest, RunResult, RuntimeModel, ToolCallRequest, UsageEvent } from '../agent-runtime/contracts'
import { piModelAdapter } from './model'
import { cancelPiPending } from './cancel'

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
function imageContent(url: string): ImageContent {
  const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(url)
  if (!match) throw new Error('Pi images must be base64 image data URLs')
  return { type: 'image', mimeType: match[1], data: match[2] }
}
function toolContent(value: unknown): { content: (TextContent | ImageContent)[]; isError?: boolean } {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const blocks = Array.isArray(value) ? value : Array.isArray(result?.content) ? result.content : [value]
  const content: (TextContent | ImageContent)[] = blocks.map((block) => {
    if (typeof block === 'string') return { type: 'text', text: block }
    const item = block && typeof block === 'object' ? (block as Record<string, unknown>) : null
    if (item?.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text }
    if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string')
      return { type: 'image', data: item.data, mimeType: item.mimeType }
    if (item?.type === 'image_url') {
      const url = typeof item.image_url === 'string' ? item.image_url : (item.image_url as { url?: string } | undefined)?.url
      if (typeof url === 'string') return imageContent(url)
    }
    return { type: 'text', text: JSON.stringify(block) ?? '' }
  })
  return { content, ...(result?.isError === true || result?.status === 'error' ? { isError: true } : {}) }
}
export class PiRunner {
  private active = new Map<string, { controller: AbortController; state: PiSnapshot }>()
  constructor(private deps: PiRunnerDeps) {}
  abort(threadId: string): void {
    const active = this.active.get(threadId)
    active?.controller.abort()
    const state = active?.state ?? this.deps.read(threadId)
    if (!state) return
    const messages = cancelPiPending(state)
    this.deps.write(threadId, state)
    for (const message of messages) this.deps.emit({ type: 'message', threadId, message })
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
  forkPoint(threadId: string, messageId: string): string | null {
    const state = this.deps.read(threadId)
    if (!state || state.pending || state.inFlight) return null
    const index = state.ui.findIndex((message) => message.id === messageId && message.role === 'user')
    if (index < 0) return null
    return messageId
  }
  deleteThread(threadId: string): void {
    if (this.active.has(threadId)) throw new Error('Pi conversation is still running')
    this.deps.remove(threadId)
  }
  async run(req: RunRequest): Promise<RunResult> {
    if (this.active.has(req.threadId)) throw new Error('Pi conversation is already running')
    const state = this.deps.read(req.threadId) ?? { messages: [], ui: [], pending: null, inFlight: null }
    if (req.fromCheckpointId) {
      const target = state.ui.findIndex((message) => message.id === req.fromCheckpointId && message.role === 'user')
      if (target < 0) throw new Error('Pi checkpoint does not exist')
      const userBefore = state.ui.slice(0, target).filter((message) => message.role === 'user').length
      let seen = 0
      const cut = state.messages.findIndex((message) => {
        if (message.role !== 'user') return false
        if (seen === userBefore) return true
        seen += 1
        return false
      })
      if (cut >= 0) state.messages = state.messages.slice(0, cut)
      state.pending = null
      state.inFlight = null
      this.deps.write(req.threadId, state)
    }
    if (state.inFlight) throw new Error('A Pi tool outcome is unknown after interruption; it will not be executed again automatically')
    // The first system message belongs to Navo; later Pi tool-change messages stay intact.
    const system = state.messages.findIndex((message) => message.role === 'system')
    const prompt = { role: 'system' as const, content: req.systemPrompt, timestamp: Date.now() }
    if (system < 0) state.messages.unshift(prompt)
    else state.messages[system] = prompt
    this.deps.write(req.threadId, state)
    const controller = new AbortController()
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
        if (controller.signal.aborted) throw new Error('Pi run cancelled')
        return { ...toolContent(value), details: {} }
      },
    }))
    let finalText = ''
    let messageId = ''
    let error: string | undefined
    const emit = async (event: AgentEvent): Promise<void> => {
      if (controller.signal.aborted) return
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
          images: message.content.filter((c) => c.type === 'image').map((c) => `data:${c.mimeType};base64,${c.data}`),
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
        if (controller.signal.aborted) throw new Error('Pi run cancelled')
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
    this.active.set(req.threadId, { controller, state })
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
        const images = req.input.images.map(imageContent)
        if (images.length && !req.model.supportsVision) throw new Error('The selected Pi model does not support images')
        ui({
          id: req.input.id,
          role: 'user',
          content: req.input.text,
          images: req.input.images.slice(req.input.attachmentImages ?? 0),
          attachments: req.input.attachments,
          memories: req.input.memories,
        })
        const text = [req.input.text, req.input.context].filter(Boolean).join('\n\n')
        const messages: AgentMessage[] = [{ role: 'user', content: images.length ? [{ type: 'text', text }, ...images] : text, timestamp: Date.now() }]
        try {
          await runAgentLoop(messages, { messages: [...state.messages], tools }, config, emit, controller.signal, stream)
        } catch (e) {
          if (!(e instanceof Pause)) throw e
        }
      }
      while (state.pending) {
        if (controller.signal.aborted) break
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
    } catch (cause) {
      if (controller.signal.aborted) return { finalText, interrupted: false, aborted: true }
      throw cause
    } finally {
      save()
      this.active.delete(req.threadId)
    }
  }
}
