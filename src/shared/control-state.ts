import type { DesktopConsentRequest } from './types'
import type { ApprovalSummary } from './reliability'

export type DesktopStopReason = 'user_takeover' | 'user_stop' | 'authorization_revoked' | 'permission_missing' | 'service_failure'
export interface DesktopStop {
  reason: DesktopStopReason
  threadId: string | null
  at: number
}
export interface DesktopGrant {
  id: string
  threadId: string
  executionId: string | null
  scope: 'execution' | 'session'
  app: string
  bundleId: string
  createdAt: number
}
export type ApprovalInboxItem =
  | (ApprovalSummary & { kind: 'tool' })
  | { kind: 'desktop'; id: string; threadId: string; threadTitle: string; executionId: string; createdAt: number; request: DesktopConsentRequest }

export type UnifiedApproval = ApprovalInboxItem
