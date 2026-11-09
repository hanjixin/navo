import { openDatabase } from '../core/db-core'
import { Rpc } from '../agent-host/rpc'
import type { RpcMessage } from '../agent-host/protocol'
import type { RunRequest, ToolCallRequest } from '../agent-runtime/contracts'
import { PiRunner } from './runner'
import { PiStateStore } from '../agent-runtime/pi-state'

interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: RpcMessage }) => void): void
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort
if (!process.env.AB_DB_PATH) throw new Error('Pi worker missing database path')
const database = openDatabase(process.env.AB_DB_PATH)
const store = new PiStateStore(database)
const runner: PiRunner = new PiRunner({
  read: (id) => store.read(id),
  write: (id, snapshot) => store.write(id, snapshot),
  remove: (id) => store.remove(id),
  list: () => store.list(),
  emit: (event) => rpc.emit('chat.event', event),
  callTool: (request: ToolCallRequest) => rpc.call('tool.call', request),
  usage: (event) => rpc.emit('usage', event),
})
const rpc: Rpc = new Rpc(
  { post: (message) => port.postMessage(message), listen: (listener) => port.on('message', (event) => listener(event.data)) },
  {
    'run.start': (request: RunRequest) => runner.run(request),
    'run.abort': ({ threadId }: { threadId: string }) => runner.abort(threadId),
    'thread.state': ({ threadId }: { threadId: string }) => runner.state(threadId),
    'approvals.recover': () => runner.pendingApprovals(),
    'thread.delete': ({ threadId }: { threadId: string }) => runner.deleteThread(threadId),
    ping: () => 'pong',
  },
)
