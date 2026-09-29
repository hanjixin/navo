// Entry of the agent utility process. Runs deepagents off the main process so long runs never
// block the UI; tools that need the browser / MCP live in the main process and are called over RPC.
import type { ChatEvent } from '@shared/types'
import { openDatabase } from '../core/db-core'
import type { RpcMessage, RunRequest, ToolCallRequest } from './protocol'
import { Rpc } from './rpc'
import { RESET, Runner } from './runner'

interface ParentPort {
  postMessage(msg: unknown): void
  on(event: 'message', fn: (e: { data: RpcMessage }) => void): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

const dbPath = process.env.AB_DB_PATH
const checkpointsPath = process.env.AB_CHECKPOINTS_PATH
if (!dbPath || !checkpointsPath) throw new Error('agent host: missing AB_DB_PATH / AB_CHECKPOINTS_PATH')

const runner = new Runner({
  db: openDatabase(dbPath),
  checkpointsPath,
  emit: (e: ChatEvent) => rpc.emit('chat.event', e),
  callTool: (req: ToolCallRequest) => rpc.call('tool.call', req),
})

// closures above only run after this assignment
const rpc: Rpc = new Rpc(
  { post: (m) => parentPort.postMessage(m), listen: (fn) => parentPort.on('message', (e) => fn(e.data)) },
  {
    'run.start': (req: RunRequest) => runner.run(req),
    'run.abort': ({ threadId }: { threadId: string }) => runner.abort(threadId),
    'thread.state': ({ threadId }: { threadId: string }) => runner.state(threadId),
    'thread.forkPoint': ({ threadId, messageId }: { threadId: string; messageId: string }) => runner.forkPoint(threadId, messageId),
    'thread.delete': ({ threadId }: { threadId: string }) => runner.deleteThread(threadId),
    ping: () => 'pong',
  },
)

export { RESET }
process.on('unhandledRejection', (err) => console.error('[agent-host] unhandled rejection', err))
