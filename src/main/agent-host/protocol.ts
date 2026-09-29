import type { Decision, MessageAttachment, MemoryRef } from '@shared/types'
import type { ResolvedModel } from '../models/factory'

export type ToolSource = 'browser' | 'plugin' | 'macro' | 'mcp' | 'connector' | 'navo'

/** A tool implemented in the main process and proxied into the agent process. */
export interface ToolDescriptor {
  name: string
  description: string
  /** JSON Schema of the arguments */
  schema: Record<string, unknown>
  source: ToolSource
}

export interface RunRequest {
  runId: string
  threadId: string
  input:
    | {
        kind: 'message'
        id: string
        text: string
        images: string[]
        /** extra context sent to the model but not shown in the user's bubble (parsed attachments) */
        context?: string
        attachments?: MessageAttachment[]
        /** leading images that came from attachments (hidden in the user bubble, shown as chips) */
        attachmentImages?: number
        /** memories picked for this message (shown under the user bubble) */
        memories?: MemoryRef[]
      }
    | { kind: 'resume'; decisions: Decision[] }
  /** Fork from this checkpoint instead of the latest one (regenerate / edit & resend) */
  fromCheckpointId?: string
  model: ResolvedModel
  systemPrompt: string
  tools: ToolDescriptor[]
  /** Tool names that pause for human approval */
  interruptOn: string[]
  browserSubagent: boolean
  mounts: { id: string; root: string; allowed: string[] }[]
  paths: { skills: string; workspace: string; uploads: string }
  devMode: boolean
  langfuse?: LangfuseConfig
  /** metadata attached to the trace */
  meta: { threadTitle: string; modelLabel: string; appVersion: string }
}

export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl: string
  environment: string
  includeScreenshots: boolean
  projectId?: string | null
}

export interface RunResult {
  finalText: string
  interrupted: boolean
  error?: string
  aborted?: boolean
  traceUrl?: string
}

export interface ToolCallRequest {
  runId: string
  threadId: string
  name: string
  args: Record<string, unknown>
}

export type RpcMessage =
  | { kind: 'req'; id: number; method: string; params: unknown }
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: string }
  | { kind: 'evt'; name: string; payload: unknown }
