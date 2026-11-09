// Compatibility exports for the bundled worker. Application contracts live above engines.
export type { ToolSource, ToolDescriptor, RunRequest, RunResult, LangfuseConfig, UsageEvent, ToolCallRequest, WorkspaceWrite } from '../agent-runtime/contracts'

export type RpcMessage =
  | { kind: 'req'; id: number; method: string; params: unknown }
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: string }
  | { kind: 'evt'; name: string; payload: unknown }
