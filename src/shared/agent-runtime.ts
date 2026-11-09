/** Agent engines are independent of the model providers configured in Navo. */
export type AgentRuntimeKind = 'builtin' | 'pi' | 'claude' | 'dsh' | 'codex'

export interface AgentRuntimeProfile {
  id: string
  kind: AgentRuntimeKind
  name: string
  enabled: boolean
  command: string
  args: string[]
  model?: string
  provider?: string
}

export interface AgentRuntimeCapabilities {
  navoTools: boolean
  nativeTools: boolean
  approvals: boolean
  images: boolean
  resume: boolean
  fork: boolean
  tokenStreaming: boolean
  /** Runtime requires a Navo-configured model rather than its own model profile. */
  requiresNavoModel?: boolean
  /** Include Navo workspace file tools when Navo tools are enabled. */
  workspaceTools?: boolean
}

export interface AgentRuntimeInfo {
  profile: AgentRuntimeProfile
  capabilities: AgentRuntimeCapabilities
}

export interface AgentRuntimeStatus {
  available: boolean
  version?: string
  error?: string
}
