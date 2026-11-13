import type { ThreadState } from '@shared/types'
import { db } from '../core/db'
import type { AgentRuntime, RuntimeCallbacks } from './types'
import type { RunRequest, RunResult } from './contracts'
import { PiStateStore } from './pi-state'
import { BuiltinRuntimeAdapter } from './builtin'
import { cancelPiPending } from '../pi-host/cancel'

/** Pi Core executes in an isolated worker; history and approvals never start the worker. */
export class PiRuntimeAdapter implements AgentRuntime {
  readonly capabilities = {
    navoTools: true,
    nativeTools: false,
    approvals: true,
    images: true,
    resume: true,
    fork: true,
    tokenStreaming: true,
    requiresNavoModel: true,
    workspaceTools: true,
  }
  private readonly worker: BuiltinRuntimeAdapter
  constructor(private readonly callbacks: RuntimeCallbacks) {
    this.worker = new BuiltinRuntimeAdapter(callbacks, 'out/main/pi-host.js')
  }
  private get store(): PiStateStore {
    return new PiStateStore(db())
  }
  run(request: RunRequest): Promise<RunResult> {
    return this.worker.run(request)
  }
  async abort(threadId: string): Promise<void> {
    const interruptId = this.store.read(threadId)?.pending?.interrupt.id
    try {
      await this.worker.abort(threadId)
    } finally {
      // No worker after restart (or a failed RPC) must not leave the original approval stuck.
      // A delayed abort response must never cancel an approval created by a newer run.
      const saved = this.store.read(threadId)
      if (interruptId && saved?.pending?.interrupt.id === interruptId) {
        const messages = cancelPiPending(saved)
        this.store.write(threadId, saved)
        for (const message of messages) this.callbacks.event({ type: 'message', threadId, message })
      }
    }
  }
  async state(threadId: string): Promise<Omit<ThreadState, 'running'>> {
    const saved = this.store.read(threadId)
    return { messages: saved?.ui ?? [], todos: [], interrupt: saved?.pending && !saved.pending.approved ? saved.pending.interrupt : null }
  }
  async pendingApprovals(): Promise<{ threadId: string; interrupt: NonNullable<ThreadState['interrupt']> }[]> {
    const result = []
    for (const threadId of this.store.list()) {
      const state = await this.state(threadId)
      if (state.interrupt) result.push({ threadId, interrupt: state.interrupt })
    }
    return result
  }
  async forkPoint(threadId: string, messageId: string): Promise<string | null> {
    const saved = this.store.read(threadId)
    if (!saved || saved.pending || saved.inFlight) return null
    return saved.ui.some((message) => message.id === messageId && message.role === 'user') ? messageId : null
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.worker.deleteThread(threadId)
    this.store.remove(threadId)
  }
  refresh(): void {
    this.worker.refresh()
  }
  shutdown(): void {
    this.worker.shutdown()
  }
}
