import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { db } from '../core/db'
import { paths } from '../core/paths'
import type { ThreadState, UIMessage, ChatEvent, PendingInterrupt, Decision } from '@shared/types'
import type { AgentRuntimeProfile } from '@shared/agent-runtime'
import type { RunRequest, RunResult } from './contracts'
import type { AgentRuntime, ExternalRuntimeDriver, RuntimeCallbacks, RuntimeSessionReference, RuntimeToolInvocation, RuntimeToolResult } from './types'
import { KvRuntimeStateStore, type RuntimeStateStore } from './state-store'
import { normalizeRuntimeText } from './message-normalizer'

interface PendingTool {
  call: RuntimeToolInvocation
  executionId: string
  messageId: string
  interrupt: PendingInterrupt
}
export interface ExternalSavedSession {
  kind: AgentRuntimeProfile['kind']
  session: RuntimeSessionReference | null
  messages: UIMessage[]
  pending?: PendingTool | null
  inFlight?: PendingTool | null
  uncertainTools?: string[]
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
interface LiveRun {
  controller: AbortController
  request: RunRequest
  executionId: string
  saved: ExternalSavedSession
  segment: ReturnType<typeof deferred<RunResult>> | null
  decision: ReturnType<typeof deferred<Decision>> | null
  queue: Promise<unknown>
  calls: Map<string, { fingerprint: string; promise: Promise<RuntimeToolResult> }>
  activeCalls: Set<string>
  accepted: boolean
  initialInput: Extract<RunRequest['input'], { kind: 'message' }>
  prefix: string
  finalText: string
  done: ReturnType<typeof deferred<void>>
}
function displayMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return structuredClone(message)
    const normalized = normalizeRuntimeText(message.content)
    return {
      ...structuredClone(message),
      content: normalized.text,
      ...(normalized.diagnostics.length ? { runtimeWarning: 'unexecuted_tool_markup' as const } : {}),
    }
  })
}
function resultOf(value: unknown): RuntimeToolResult {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] }
  const result = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const blocks = Array.isArray(value) ? value : Array.isArray(result?.content) ? result.content : null
  if (blocks) {
    const content: RuntimeToolResult['content'] = []
    for (const block of blocks) {
      const item = block as Record<string, unknown>
      if (item?.type === 'text' && typeof item.text === 'string') content.push({ type: 'text', text: item.text })
      else if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string')
        content.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      else content.push({ type: 'text', text: JSON.stringify(block) ?? '' })
    }
    return { content, ...(result?.isError === true || result?.status === 'error' ? { isError: true } : {}) }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(value) ?? '' }],
    ...(result?.isError === true || result?.status === 'error' ? { isError: true } : {}),
  }
}
const errorResult = (text: string): RuntimeToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** Engine processes survive an approval pause. A resumed segment gets a fresh Navo run ID. */
export class ExternalRuntimeAdapter implements AgentRuntime {
  readonly capabilities
  private deleted = false
  private live: LiveRun | null = null
  private readonly stateStore: RuntimeStateStore<ExternalSavedSession>
  constructor(
    private readonly threadId: string,
    private readonly profile: AgentRuntimeProfile,
    private readonly driver: ExternalRuntimeDriver,
    private readonly callbacks: RuntimeCallbacks,
    private readonly onDelete?: () => void,
    stateStore?: RuntimeStateStore<ExternalSavedSession>,
  ) {
    this.capabilities = driver.capabilities
    this.stateStore = stateStore ?? new KvRuntimeStateStore<ExternalSavedSession>(db(), 'runtime.session')
  }
  private persist(saved: ExternalSavedSession): void {
    if (!this.deleted) this.stateStore.write(this.threadId, saved)
  }
  private closeTool(saved: ExternalSavedSession, pending: PendingTool, unknown: boolean, cancelled: boolean): UIMessage[] {
    const callMessage: UIMessage = {
      id: `${pending.messageId}:call`,
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: pending.messageId,
          name: pending.call.name,
          args: pending.call.args,
          activity: { kind: 'tool', status: cancelled && !unknown ? 'cancelled' : 'error' },
        },
      ],
    }
    const resultMessage: UIMessage = {
      id: `${pending.messageId}:result`,
      role: 'tool',
      toolCallId: pending.messageId,
      toolName: pending.call.name,
      content: unknown
        ? 'The tool outcome is unknown after interruption. It has not been replayed.'
        : 'The runtime disconnected before approval. This tool was not executed.',
      status: 'error',
      runtimeWarning: unknown ? 'tool_outcome_unknown' : 'runtime_disconnected',
    }
    for (const message of [callMessage, resultMessage]) {
      const index = saved.messages.findIndex((item) => item.id === message.id)
      if (index < 0) saved.messages.push(message)
      else saved.messages[index] = message
    }
    return [callMessage, resultMessage]
  }
  private read(): ExternalSavedSession {
    const saved = this.stateStore.read(this.threadId) ?? { kind: this.profile.kind, session: null, messages: [] }
    if (saved.kind !== this.profile.kind) throw new Error('Agent runtime session does not match this conversation')
    // A CLI session can restore conversation history, never an old MCP response channel.
    if (!this.live && (saved.pending || saved.inFlight)) {
      const pending = saved.inFlight ?? saved.pending!
      const unknown = !!saved.inFlight
      this.closeTool(saved, pending, unknown, false)
      if (unknown) saved.uncertainTools = [...new Set([...(saved.uncertainTools ?? []), pending.call.name])]
      saved.pending = null
      saved.inFlight = null
      this.persist(saved)
    }
    return saved
  }
  private valid(live: LiveRun): boolean {
    return !this.deleted && this.live === live && !live.controller.signal.aborted
  }
  private accept(live: LiveRun): void {
    if (live.accepted) return
    live.accepted = true
    const input = live.initialInput
    this.upsert(live, { id: input.id, role: 'user', content: input.text, attachments: input.attachments, memories: input.memories })
  }
  private upsert(live: LiveRun, message: UIMessage): void {
    const index = live.saved.messages.findIndex((item) => item.id === message.id)
    if (index < 0) live.saved.messages.push(message)
    else live.saved.messages[index] = message
    this.persist(live.saved)
  }
  private emit(live: LiveRun, event: ChatEvent): void {
    if (!this.valid(live) || event.threadId !== this.threadId) return
    if (event.type === 'run_start' || event.type === 'run_end' || event.type === 'interrupt') return
    if (event.type === 'message') {
      this.accept(live)
      const normalized = event.message.role === 'assistant' ? displayMessages([event.message])[0] : event.message
      this.upsert(live, normalized)
      if (normalized.role === 'assistant' && normalized.content) live.finalText = normalized.content
      this.callbacks.event({ ...event, message: normalized })
      return
    }
    if (event.type === 'token') {
      this.accept(live)
      const message = live.saved.messages.find((item) => item.id === event.messageId) ?? { id: event.messageId, role: 'assistant' as const, content: '' }
      if (event.reasoning) message.reasoning = (message.reasoning ?? '') + event.text
      else message.content += event.text
      if (!live.saved.messages.some((item) => item.id === message.id)) live.saved.messages.push(message)
    }
    this.callbacks.event(event)
  }
  private toolEvent(live: LiveRun, pending: PendingTool, status: 'pending' | 'running' | 'success' | 'error' | 'cancelled') {
    this.emit(live, {
      type: 'message',
      threadId: this.threadId,
      message: {
        id: `${pending.messageId}:call`,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: pending.messageId, name: pending.call.name, args: pending.call.args, activity: { kind: 'tool', status } }],
      },
    })
  }
  private toolResult(live: LiveRun, pending: PendingTool, result: RuntimeToolResult, warning?: UIMessage['runtimeWarning']): void {
    this.emit(live, {
      type: 'message',
      threadId: this.threadId,
      message: {
        id: `${pending.messageId}:result`,
        role: 'tool',
        toolCallId: pending.messageId,
        toolName: pending.call.name,
        content: result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n'),
        images: result.content.filter((part) => part.type === 'image').map((part) => `data:${part.mimeType};base64,${part.data}`),
        status: result.isError ? 'error' : 'success',
        runtimeWarning: warning,
      },
    })
  }
  private dispatch(live: LiveRun, call: RuntimeToolInvocation): Promise<RuntimeToolResult> {
    if (!this.valid(live)) return Promise.resolve(errorResult('Runtime stopped'))
    if (!call.id || !live.request.tools.some((tool) => tool.name === call.name) || !call.args || typeof call.args !== 'object' || Array.isArray(call.args))
      return Promise.resolve(errorResult('Unknown or invalid Navo tool request'))
    const fingerprint = JSON.stringify([call.name, call.args])
    const previous = live.calls.get(call.id)
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.resolve(errorResult('Tool request ID reused with different content'))
    live.activeCalls.add(call.id)
    const promise = live.queue.then(() => this.execute(live, structuredClone(call))).finally(() => live.activeCalls.delete(call.id))
    live.queue = promise.catch(() => undefined)
    live.calls.set(call.id, { fingerprint, promise })
    return promise
  }
  private async execute(live: LiveRun, call: RuntimeToolInvocation): Promise<RuntimeToolResult> {
    if (!this.valid(live)) return errorResult('Runtime stopped')
    const pending: PendingTool = {
      call,
      executionId: live.executionId,
      messageId: `${live.prefix}:tool:${call.id}`,
      interrupt: { id: randomUUID(), actionRequests: [{ name: call.name, args: call.args }], allowedDecisions: [['approve', 'edit', 'reject']] },
    }
    const needsApproval = live.request.interruptOn.includes(call.name) || live.saved.uncertainTools?.includes(call.name)
    if (needsApproval) {
      live.saved.pending = pending
      live.decision = deferred<Decision>()
      this.toolEvent(live, pending, 'pending')
      this.persist(live.saved)
      this.callbacks.event({ type: 'interrupt', threadId: this.threadId, interrupt: pending.interrupt })
      const segment = live.segment
      live.segment = null
      segment?.resolve({ finalText: live.finalText, interrupted: true })
      let decision: Decision
      try {
        decision = await live.decision.promise
      } catch {
        return errorResult('Tool approval cancelled')
      }
      if (!this.valid(live)) return errorResult('Runtime stopped')
      live.decision = null
      live.saved.pending = null
      if (decision.type === 'reject') {
        const result = errorResult(decision.message ?? 'User rejected this operation')
        this.toolEvent(live, pending, 'cancelled')
        this.toolResult(live, pending, result)
        return result
      }
      if (decision.type === 'edit') pending.call.args = decision.editedAction.args
    }
    if (!this.valid(live)) return errorResult('Runtime stopped')
    if (!live.request.tools.some((tool) => tool.name === call.name)) {
      const result = errorResult('Tool is no longer available')
      this.toolEvent(live, pending, 'error')
      this.toolResult(live, pending, result)
      return result
    }
    this.toolEvent(live, pending, 'running')
    live.saved.inFlight = pending
    this.persist(live.saved)
    let result: RuntimeToolResult
    try {
      result = resultOf(await this.callbacks.callTool({ runId: live.request.runId, threadId: this.threadId, name: call.name, args: pending.call.args }))
    } catch (error) {
      result = errorResult(error instanceof Error ? error.message : String(error))
    }
    if (!this.valid(live)) {
      live.saved.uncertainTools = [...new Set([...(live.saved.uncertainTools ?? []), call.name])]
      if (this.live === live) this.persist(live.saved)
      return errorResult('The tool outcome is unknown after cancellation; it was not replayed')
    }
    this.toolEvent(live, pending, result.isError ? 'error' : 'success')
    this.toolResult(live, pending, result)
    live.saved.inFlight = null
    this.persist(live.saved)
    return result
  }
  async run(request: RunRequest): Promise<RunResult> {
    if (request.threadId !== this.threadId || this.deleted) throw new Error('Agent runtime conversation is no longer available')
    if (request.fromCheckpointId) throw new Error('This agent runtime does not support checkpoint resume')
    if (request.input.kind === 'resume') {
      const live = this.live
      if (!this.capabilities.approvals || !live || !this.valid(live) || !live.decision || !live.saved.pending || live.segment)
        throw new Error('The runtime approval is no longer available. Continue the conversation explicitly.')
      if (request.executionId !== live.executionId) throw new Error('Approval belongs to another execution')
      const decisions = request.input.decisions
      if (decisions.length !== 1) throw new Error('Expected one tool approval decision')
      const decision = decisions[0]
      if (!decision || !['approve', 'reject', 'edit'].includes(decision.type)) throw new Error('Invalid approval decision')
      if (
        decision.type === 'edit' &&
        (!decision.editedAction ||
          decision.editedAction.name !== live.saved.pending.call.name ||
          !decision.editedAction.args ||
          typeof decision.editedAction.args !== 'object' ||
          Array.isArray(decision.editedAction.args))
      )
        throw new Error('Approval cannot change the requested tool')
      live.request = request
      live.segment = deferred<RunResult>()
      const promise = live.segment.promise
      live.decision.resolve(decision)
      return promise
    }
    if (this.live?.controller.signal.aborted) await this.live.done.promise
    if (this.live) throw new Error('Agent runtime is already running or waiting for approval')
    if (request.input.images.length && !this.capabilities.images) throw new Error('This agent runtime does not support images')
    const live: LiveRun = {
      controller: new AbortController(),
      request,
      executionId: request.executionId ?? request.runId,
      saved: this.read(),
      segment: deferred<RunResult>(),
      decision: null,
      queue: Promise.resolve(),
      calls: new Map(),
      activeCalls: new Set(),
      accepted: false,
      initialInput: request.input,
      prefix: request.runId,
      finalText: '',
      done: deferred<void>(),
    }
    this.live = live
    const response = live.segment!.promise
    const work = this.driver.run({
      profile: this.profile,
      request,
      session: live.saved.session,
      stateDir: join(paths.userData, 'runtimes', this.profile.kind, createHash('sha256').update(this.threadId).digest('hex')),
      signal: live.controller.signal,
      emit: (event) => this.emit(live, event),
      usage: (event) => {
        if (this.valid(live) && event.threadId === this.threadId) this.callbacks.usage(event)
      },
      saveSession: (session) => {
        if (this.valid(live)) {
          live.saved.session = session
          this.persist(live.saved)
        }
      },
      ...(this.capabilities.navoTools
        ? {
            tools: {
              call: (call: RuntimeToolInvocation) => this.dispatch(live, call),
              cancel: (id: string) => {
                if (this.valid(live) && live.activeCalls.has(id)) this.abort(this.threadId)
              },
            },
          }
        : {}),
    })
    void work.then(
      (result) => this.finish(live, result),
      (error) => this.finish(live, undefined, error),
    )
    return response
  }
  private finish(live: LiveRun, result?: RunResult, failure?: unknown): void {
    if (this.live !== live) return
    const aborted = live.controller.signal.aborted
    if (!failure && result && !result.error && !result.aborted && !aborted) this.accept(live)
    const pending = live.saved.inFlight ?? live.saved.pending
    if (pending) {
      const unknown = !!live.saved.inFlight
      if (unknown) live.saved.uncertainTools = [...new Set([...(live.saved.uncertainTools ?? []), pending.call.name])]
      // Cancellation must still leave a durable final state, although live event forwarding has stopped.
      const terminalMessages = this.closeTool(live.saved, pending, unknown, aborted)
      this.persist(live.saved)
      if (!this.deleted) for (const message of terminalMessages) this.callbacks.event({ type: 'message', threadId: this.threadId, message })
    }
    // Native tools are observed rather than dispatched here. If cancellation cut their
    // final event off, the UI must still stop showing them as running.
    const finishedTools = new Set(live.saved.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId))
    for (const message of [...live.saved.messages]) {
      const calls = message.toolCalls?.filter((call) => !finishedTools.has(call.id) && ['pending', 'running'].includes(call.activity?.status ?? '')) ?? []
      for (const call of calls) {
        const updated: UIMessage = {
          ...message,
          toolCalls: message.toolCalls!.map((item) =>
            item.id === call.id ? { ...item, activity: { ...item.activity!, status: aborted ? 'cancelled' : 'error' } } : item,
          ),
        }
        const resultMessage: UIMessage = {
          id: `${call.id}:result`,
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: 'The runtime ended before this tool reported a final outcome.',
          status: 'error',
          runtimeWarning: 'tool_outcome_unknown',
        }
        this.upsert(live, updated)
        this.upsert(live, resultMessage)
        if (!this.deleted)
          for (const terminal of [updated, resultMessage]) this.callbacks.event({ type: 'message', threadId: this.threadId, message: terminal })
      }
    }
    const suspended = !live.segment
    live.saved.pending = null
    live.saved.inFlight = null
    live.decision?.reject(new Error('Runtime ended'))
    this.persist(live.saved)
    this.live = null
    live.done.resolve()
    if (aborted) live.segment?.resolve({ finalText: live.finalText, interrupted: false, aborted: true })
    else if (failure) live.segment?.reject(failure)
    else live.segment?.resolve(result!)
    if (suspended)
      this.callbacks.unavailable?.({
        threadId: this.threadId,
        executionId: live.executionId,
        runId: live.request.runId,
        error: aborted
          ? 'Runtime stopped; pending tool was not replayed.'
          : failure instanceof Error
            ? failure.message
            : (result?.error ?? 'Runtime disconnected while waiting for approval.'),
      })
  }
  abort(threadId: string): void {
    if (threadId !== this.threadId) return
    const live = this.live
    if (!live) return
    live.controller.abort()
    live.decision?.reject(new Error('Runtime stopped'))
  }
  async state(threadId: string): Promise<Omit<ThreadState, 'running'>> {
    if (threadId !== this.threadId) throw new Error('Agent runtime conversation mismatch')
    const saved = this.live?.saved ?? this.read()
    return { messages: displayMessages(saved.messages), todos: [], interrupt: this.live && this.valid(this.live) ? (saved.pending?.interrupt ?? null) : null }
  }
  async pendingApprovals(): Promise<{ threadId: string; interrupt: PendingInterrupt }[]> {
    const state = await this.state(this.threadId)
    return state.interrupt ? [{ threadId: this.threadId, interrupt: state.interrupt }] : []
  }
  async forkPoint(): Promise<null> {
    throw new Error('This agent runtime does not support regenerating historical messages')
  }
  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.threadId) throw new Error('Agent runtime conversation mismatch')
    this.deleted = true
    this.abort(threadId)
    this.stateStore.remove(this.threadId)
    this.onDelete?.()
  }
  refresh(): void {
    /* Existing threads retain their config and live approvals. */
  }
  shutdown(): void {
    this.abort(this.threadId)
  }
}
