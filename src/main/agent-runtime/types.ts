import type { ChatEvent, ThreadState } from '@shared/types'
import type { AgentRuntimeKind, AgentRuntimeProfile, AgentRuntimeCapabilities } from '@shared/agent-runtime'
import type { RunRequest, RunResult, ToolCallRequest, WorkspaceWrite, UsageEvent } from './contracts'

export interface RuntimeCallbacks {
  event(event: ChatEvent): void
  callTool(request: ToolCallRequest): Promise<unknown>
  workspaceWrite(event: WorkspaceWrite): void | Promise<void>
  usage(event: UsageEvent): void
  /** A suspended engine exited; invalidate its live approval without replaying it. */
  unavailable?(event: { threadId: string; executionId: string; runId: string; error: string }): void
}

/** The application owns durable submissions and execution IDs; adapters own engine sessions. */
export interface AgentRuntime {
  readonly capabilities: AgentRuntimeCapabilities
  run(request: RunRequest): Promise<RunResult>
  abort(threadId: string): void | Promise<void>
  state(threadId: string): Promise<Omit<ThreadState, 'running'>>
  pendingApprovals(): Promise<{ threadId: string; interrupt: NonNullable<ThreadState['interrupt']> }[]>
  forkPoint(threadId: string, messageId: string): Promise<string | null>
  deleteThread(threadId: string): Promise<void>
  refresh(): void
  shutdown(): void
}

export type RuntimeSessionReference = Record<string, string>

export type RuntimeToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface RuntimeToolResult {
  content: RuntimeToolContent[]
  isError?: boolean
}
export interface RuntimeToolInvocation {
  id: string
  name: string
  args: Record<string, unknown>
}
export interface RuntimeToolDispatcher {
  call(input: RuntimeToolInvocation): Promise<RuntimeToolResult>
  cancel?(id: string): void
}

/** CLI protocols are translated here; no renderer or task code parses vendor messages. */
export interface ExternalRuntimeContext {
  profile: AgentRuntimeProfile
  request: RunRequest
  session: RuntimeSessionReference | null
  stateDir: string
  signal: AbortSignal
  emit(event: ChatEvent): void
  usage(event: UsageEvent): void
  saveSession(session: RuntimeSessionReference): void
  /** Only structured requests on the current engine connection may use this bridge. */
  tools?: RuntimeToolDispatcher
  watchdog?: { activity(): void; pause(): void; resume(): void }
}

export interface ExternalRuntimeDriver {
  readonly kind: Exclude<AgentRuntimeKind, 'builtin'>
  readonly capabilities: AgentRuntimeCapabilities
  run(context: ExternalRuntimeContext): Promise<RunResult>
}
