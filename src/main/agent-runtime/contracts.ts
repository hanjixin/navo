import type { Decision, MessageAttachment, MemoryRef, ModelConfig, ProviderType } from '@shared/types'

/** Serializable model configuration. External engines use their own profile/authentication. */
export interface RuntimeModel {
  id?: string
  providerType: ProviderType
  model: string
  apiKey?: string
  baseURL?: string | null
  headers?: Record<string, string> | null
  temperature?: number | null
  maxTokens?: number | null
  reasoningEffort?: ModelConfig['reasoningEffort']
  supportsVision: boolean
}

export type ToolSource = 'browser' | 'desktop' | 'plugin' | 'macro' | 'mcp' | 'connector' | 'navo'

/** A tool implemented in the main process and proxied into the agent process. */
export interface ToolDescriptor {
  name: string
  description: string
  /** JSON Schema of the arguments */
  schema: Record<string, unknown>
  source: ToolSource
}

export interface RunRequest {
  executionId?: string
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
  model: RuntimeModel
  systemPrompt: string
  tools: ToolDescriptor[]
  /** Tool names that pause for human approval */
  interruptOn: string[]
  browserSubagent: boolean
  /** the run's memory section, also given to the browser-operator subagent */
  memoryPrompt?: string
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

/** a model call's tokens, reported from the agent process */
export interface UsageEvent {
  threadId: string
  modelId?: string
  model: string
  usage: { input: number; output: number; cached: number }
}

export interface ToolCallRequest {
  runId: string
  threadId: string
  name: string
  args: Record<string, unknown>
}

export interface WorkspaceWrite {
  runId: string
  threadId: string
  path: string
}
