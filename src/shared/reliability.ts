import type { PendingInterrupt } from './types'

export interface DraftScope {
  surface: 'main' | 'quick'
  threadId?: string
  projectId?: string
}

export type { ProjectFileRef as ProjectFileReference } from './files-query'
import type { ProjectFileRef as ProjectFileReference } from './files-query'

export interface ChatDraft {
  editorId?: string
  editRevision?: number
  scope: DraftScope
  text: string
  fileIds: string[]
  projectFiles: ProjectFileReference[]
  modelId: string | null
  version: number
  updatedAt: number
}

export interface DraftSaveInput {
  editorId?: string
  editRevision?: number
  scope: DraftScope
  text: string
  fileIds: string[]
  projectFiles: ProjectFileReference[]
  modelId: string | null
  expectedVersion: number
}

export interface ChatSubmitInput {
  requestId: string
  threadId?: string
  projectId?: string | null
  modelId?: string | null
  text: string
  images?: string[]
  fileIds?: string[]
  projectFiles?: ProjectFileReference[]
  draft?: { scope: DraftScope; version: number }
}

export interface ChatSubmitReceipt {
  requestId: string
  threadId: string
  messageId: string
  executionId: string
}

export type ExecutionPhase = 'running' | 'waiting_approval' | 'success' | 'error' | 'cancelled'

export interface ApprovalSummary {
  threadId: string
  threadTitle: string
  projectId: string | null
  executionId: string
  interrupt: PendingInterrupt
  updatedAt: number
}
