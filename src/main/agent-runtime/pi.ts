import type { ThreadState } from '@shared/types'
import { db } from '../core/db'
import type { AgentRuntime, RuntimeCallbacks } from './types'
import type { RunRequest, RunResult } from './contracts'
import { PiStateStore } from './pi-state'
import { BuiltinRuntimeAdapter } from './builtin'

/** Pi Core executes in an isolated worker; history and approvals never start the worker. */
export class PiRuntimeAdapter implements AgentRuntime {
  readonly capabilities = {
    navoTools: true,
    nativeTools: false,
    approvals: true,
    images: true,
    resume: true,
    fork: false,
    tokenStreaming: true,
    requiresNavoModel: true,
    workspaceTools: true,
  }
  private readonly worker: BuiltinRuntimeAdapter
  constructor(callbacks: RuntimeCallbacks) {
    this.worker = new BuiltinRuntimeAdapter(callbacks, 'out/main/pi-host.js')
  }
  private get store(): PiStateStore {
    return new PiStateStore(db())
  }
  run(request: RunRequest): Promise<RunResult> {
    return this.worker.run(request)
  }
  abort(threadId: string): Promise<void> {
    return this.worker.abort(threadId)
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
  async forkPoint(): Promise<null> {
    throw new Error('Pi historical regeneration is not supported')
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
