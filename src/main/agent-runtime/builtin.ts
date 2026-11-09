import { utilityProcess, type UtilityProcess } from 'electron'
import { appFile } from '../core/app-dir'
import { paths } from '../core/paths'
import { log } from '../core/logger'
import { Rpc } from '../agent-host/rpc'
import type { RpcMessage } from '../agent-host/protocol'
import type { RunRequest, RunResult, ToolCallRequest, UsageEvent, WorkspaceWrite } from './contracts'
import type { ChatEvent, ThreadState } from '@shared/types'
import type { AgentRuntime, RuntimeCallbacks } from './types'

/** Keeps the existing DeepAgents worker behind the common runtime boundary. */
export class BuiltinRuntimeAdapter implements AgentRuntime {
  readonly capabilities = { navoTools: true, nativeTools: true, approvals: true, images: true, resume: true, fork: true, tokenStreaming: true }
  private child: UtilityProcess | null = null
  private rpc: Rpc | null = null
  private runs = new Map<string, Promise<RunResult>>()
  constructor(
    private readonly callbacks: RuntimeCallbacks,
    private readonly workerPath = 'out/main/agent-host.js',
  ) {}

  private host(): Rpc {
    if (this.rpc && this.child) return this.rpc
    const child = utilityProcess.fork(appFile(this.workerPath), [], {
      serviceName: 'Navo Agent',
      stdio: 'pipe',
      env: { ...process.env, AB_DB_PATH: paths.db, AB_CHECKPOINTS_PATH: paths.checkpoints },
    })
    this.child = child
    child.stdout?.on('data', (d: Buffer) => log.info(`[agent-host] ${d.toString().trim()}`))
    child.stderr?.on('data', (d: Buffer) => log.warn(`[agent-host] ${d.toString().trim()}`))
    const active = () => {
      if (this.child !== child) throw new Error('Agent runtime was replaced')
    }
    const rpc = new Rpc(
      {
        post: (m) => child.postMessage(m),
        listen: (fn) =>
          child.on('message', (m: RpcMessage) => {
            if (this.child === child) fn(m)
          }),
      },
      {
        'tool.call': (req: ToolCallRequest) => {
          active()
          return this.callbacks.callTool(req)
        },
        'workspace.write': (event: WorkspaceWrite) => {
          active()
          return this.callbacks.workspaceWrite(event)
        },
      },
      (name, payload) => {
        if (this.child !== child) return
        if (name === 'chat.event') this.callbacks.event(payload as ChatEvent)
        if (name === 'usage') this.callbacks.usage(payload as UsageEvent)
      },
    )
    child.on('exit', (code) => {
      log.warn(`[agent] host exited with code ${code}`)
      rpc.failAll('Agent 进程意外退出，请重试')
      if (this.child === child) {
        this.child = null
        this.rpc = null
      }
    })
    this.rpc = rpc
    return rpc
  }
  async run(request: RunRequest): Promise<RunResult> {
    const pending = this.host().call<RunResult>('run.start', request)
    this.runs.set(request.threadId, pending)
    try {
      return await pending
    } finally {
      if (this.runs.get(request.threadId) === pending) this.runs.delete(request.threadId)
    }
  }
  async abort(threadId: string): Promise<void> {
    await this.rpc?.call('run.abort', { threadId })
  }
  state(threadId: string): Promise<Omit<ThreadState, 'running'>> {
    return this.host().call('thread.state', { threadId })
  }
  pendingApprovals(): Promise<{ threadId: string; interrupt: NonNullable<ThreadState['interrupt']> }[]> {
    return this.host().call('approvals.recover', {})
  }
  forkPoint(threadId: string, messageId: string): Promise<string | null> {
    return this.host().call('thread.forkPoint', { threadId, messageId })
  }
  async deleteThread(threadId: string): Promise<void> {
    const pending = this.runs.get(threadId)
    if (!pending) return this.host().call('thread.delete', { threadId })
    // Delete after the aborted worker finishes its final checkpoint writes. A stuck worker
    // must not keep the UI waiting indefinitely; deferred cleanup remains attached to it.
    const cleanup = Promise.allSettled([this.abort(threadId), pending]).then(() => this.host().call<void>('thread.delete', { threadId }))
    void cleanup.catch((error) => log.warn(`[agent] deferred checkpoint deletion: ${String(error)}`))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  refresh(): void {
    this.shutdown()
  }
  shutdown(): void {
    const child = this.child
    this.child = null
    this.rpc?.failAll('Agent runtime stopped')
    this.rpc = null
    child?.kill()
  }
}
