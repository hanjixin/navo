// Entry of the file-parser utility process: parsing untrusted / huge documents happens here so a
// crash or a long OCR job never affects the main process or the UI.
import { Rpc } from '../agent-host/rpc'
import type { RpcMessage } from '../agent-host/protocol'
import { runEngine, which, type EngineJob } from './engines'
import { shutdownOcr } from './ocr'

interface ParentPort {
  postMessage(msg: unknown): void
  on(event: 'message', fn: (e: { data: RpcMessage }) => void): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

const rpc: Rpc = new Rpc(
  { post: (m) => parentPort.postMessage(m), listen: (fn) => parentPort.on('message', (e) => fn(e.data)) },
  {
    parse: async (job: Omit<EngineJob, 'options'> & { jobId: string; options: Omit<EngineJob['options'], 'onProgress'> }) =>
      runEngine({ ...job, options: { ...job.options, onProgress: (message) => rpc.emit('progress', { jobId: job.jobId, message }) } }),
    which: ({ cmd, shellPath }: { cmd: string; shellPath: string }) => which(cmd, shellPath),
    shutdown: () => shutdownOcr(),
  },
)
