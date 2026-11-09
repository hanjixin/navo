import type { RuntimeCallbacks } from './types'
import type { ToolCallRequest, WorkspaceWrite } from './contracts'

/** Engine-neutral bridge for Navo tools and workspace writes. */
export interface ToolBridge {
  call(request: ToolCallRequest): Promise<unknown>
  writeWorkspace(event: WorkspaceWrite): void | Promise<void>
}

export function toolBridgeFromCallbacks(callbacks: RuntimeCallbacks): ToolBridge {
  return {
    call: callbacks.callTool,
    writeWorkspace: callbacks.workspaceWrite,
  }
}
