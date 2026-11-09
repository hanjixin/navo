import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { db } from '../core/db'
import { paths } from '../core/paths'
import type { ThreadState, UIMessage, ChatEvent } from '@shared/types'
import type { AgentRuntimeProfile } from '@shared/agent-runtime'
import type { RunRequest, RunResult } from './contracts'
import type { AgentRuntime, ExternalRuntimeDriver, RuntimeCallbacks, RuntimeSessionReference } from './types'
import { KvRuntimeStateStore, type RuntimeStateStore } from './state-store'

interface SavedSession {
  kind: AgentRuntimeProfile['kind']
  session: RuntimeSessionReference | null
  messages: UIMessage[]
}

/** Stores display history locally; engine session references remain private to the adapter. */
export class ExternalRuntimeAdapter implements AgentRuntime {
  readonly capabilities
  private controller: AbortController | null = null
  private deleted = false
  private active: SavedSession | null = null

  constructor(
    private readonly threadId: string,
    private readonly profile: AgentRuntimeProfile,
    private readonly driver: ExternalRuntimeDriver,
    private readonly callbacks: RuntimeCallbacks,
    private readonly onDelete?: () => void,
    stateStore?: RuntimeStateStore<SavedSession>,
  ) {
    this.capabilities = driver.capabilities
    this.stateStore = stateStore ?? new KvRuntimeStateStore<SavedSession>(db(), 'runtime.session')
  }

  private readonly stateStore: RuntimeStateStore<SavedSession>

  private get key(): string {
    return `runtime.session:${this.threadId}`
  }

  private read(): SavedSession {
    const saved = this.stateStore.read(this.threadId) ?? { kind: this.profile.kind, session: null, messages: [] }
    if (saved.kind !== this.profile.kind) throw new Error('Agent runtime session does not match this conversation')
    return saved
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (request.threadId !== this.threadId || this.deleted) throw new Error('Agent runtime conversation is no longer available')
    if (this.controller) throw new Error('Agent runtime is already running')
    if (request.input.kind !== 'message' || request.fromCheckpointId) throw new Error('This agent runtime does not support Navo approval or checkpoint resume')
    if (request.input.images.length && !this.capabilities.images) throw new Error('This agent runtime does not support images')
    const saved = this.read()
    const controller = new AbortController()
    this.controller = controller
    this.active = saved
    const valid = () => this.controller === controller && !controller.signal.aborted && !this.deleted
    const persist = () => {
      if (!this.deleted) this.stateStore.write(this.threadId, saved)
    }
    const upsert = (message: UIMessage) => {
      const index = saved.messages.findIndex((item) => item.id === message.id)
      if (index < 0) saved.messages.push(message)
      else saved.messages[index] = message
    }
    const userMessage: UIMessage = {
      id: request.input.id,
      role: 'user',
      content: request.input.text,
      attachments: request.input.attachments,
      memories: request.input.memories,
    }
    let accepted = false
    const acceptUser = () => {
      if (accepted) return
      upsert(userMessage)
      accepted = true
      // state() may be read while streaming and marks this input checkpointed.
      // Persist once before exposing it, so a crash cannot hide a durable submission.
      persist()
    }
    const emit = (event: ChatEvent) => {
      if (!valid() || event.threadId !== this.threadId) return
      // Lifecycle events and approval decisions belong to the application service.
      if (event.type === 'run_start' || event.type === 'run_end' || event.type === 'interrupt') return
      if (event.type === 'message') {
        acceptUser()
        upsert(event.message)
        persist()
      } else if (event.type === 'token') {
        acceptUser()
        const message = saved.messages.find((item) => item.id === event.messageId) ?? { id: event.messageId, role: 'assistant' as const, content: '' }
        if (event.reasoning) message.reasoning = (message.reasoning ?? '') + event.text
        else message.content += event.text
        upsert(message)
      }
      this.callbacks.event(event)
    }
    try {
      const result = await this.driver.run({
        profile: this.profile,
        request,
        session: saved.session,
        stateDir: join(paths.userData, 'runtimes', this.profile.kind, createHash('sha256').update(this.threadId).digest('hex')),
        signal: controller.signal,
        emit,
        usage: (event) => {
          if (valid() && event.threadId === this.threadId) this.callbacks.usage(event)
        },
        saveSession: (session) => {
          if (!valid()) return
          saved.session = session
          persist()
        },
      })
      if (!result.error && !result.aborted && !controller.signal.aborted) acceptUser()
      return controller.signal.aborted ? { ...result, interrupted: false, aborted: true } : result
    } catch (error) {
      if (controller.signal.aborted) return { finalText: '', interrupted: false, aborted: true }
      throw error
    } finally {
      persist()
      if (this.controller === controller) {
        this.controller = null
        this.active = null
      }
    }
  }

  abort(threadId: string): void {
    if (threadId === this.threadId) this.controller?.abort()
  }

  async state(threadId: string): Promise<Omit<ThreadState, 'running'>> {
    if (threadId !== this.threadId) throw new Error('Agent runtime conversation mismatch')
    return { messages: structuredClone((this.active ?? this.read()).messages), todos: [], interrupt: null }
  }

  async pendingApprovals(): Promise<[]> {
    return []
  }

  async forkPoint(): Promise<null> {
    throw new Error('This agent runtime does not support regenerating historical messages')
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.threadId) throw new Error('Agent runtime conversation mismatch')
    this.deleted = true
    this.controller?.abort()
    this.stateStore.remove(this.threadId)
    this.onDelete?.()
  }

  refresh(): void {
    // Configuration is captured when the thread is created; only new threads use edits.
  }

  shutdown(): void {
    this.controller?.abort()
  }
}
