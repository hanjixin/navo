import type { WorkspaceWrite } from '../agent-host/protocol'

/** A host response can outlive an aborted run; never attribute it to a later run. */
export function acceptWorkspaceWrite(
  event: WorkspaceWrite,
  runs: ReadonlyMap<string, { runId: string }>,
  record: (threadId: string, path: string) => void,
): void {
  if (runs.get(event.threadId)?.runId === event.runId) record(event.threadId, event.path)
}
