import { trace } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { CallbackHandler } from '@langfuse/langchain'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import type { LangfuseConfig, RunRequest } from './protocol'

let current: { key: string; provider: NodeTracerProvider; processor: LangfuseSpanProcessor } | null = null

const IMAGE = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{64,}/g

/** Screenshots are large and may contain private pages: replace them unless the user opted in. */
export function maskImages(data: unknown): unknown {
  if (typeof data === 'string') return data.replace(IMAGE, '[截图已省略]')
  if (Array.isArray(data)) return data.map(maskImages)
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, maskImages(v)]))
  return data
}

/**
 * (Re)configures the global OpenTelemetry provider that the Langfuse CallbackHandler writes to.
 * Recreated only when the credentials / options change.
 */
async function ensureProvider(cfg: LangfuseConfig, release: string): Promise<LangfuseSpanProcessor> {
  const key = JSON.stringify([cfg.publicKey, cfg.secretKey, cfg.baseUrl, cfg.environment, cfg.includeScreenshots, release])
  if (current?.key === key) return current.processor
  if (current) {
    await current.provider.shutdown().catch(() => undefined)
    trace.disable()
  }
  const processor = new LangfuseSpanProcessor({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
    environment: cfg.environment,
    release,
    // flush explicitly at the end of each run instead of batching for minutes
    flushAt: 50,
    flushInterval: 5,
    mask: cfg.includeScreenshots ? undefined : ({ data }) => maskImages(data),
  })
  const provider = new NodeTracerProvider({ spanProcessors: [processor] })
  provider.register()
  current = { key, provider, processor }
  return processor
}

export interface RunTracing {
  callbacks: CallbackHandler[]
  /** Flushes spans and returns a link to the trace (when the project id is known). */
  finish: () => Promise<string | undefined>
}

export async function startTracing(req: RunRequest): Promise<RunTracing | null> {
  const cfg = req.langfuse
  if (!cfg) {
    if (current) {
      await current.provider.shutdown().catch(() => undefined)
      trace.disable()
      current = null
    }
    return null
  }
  const processor = await ensureProvider(cfg, req.meta.appVersion)
  const handler = new CallbackHandler({
    sessionId: req.threadId,
    tags: ['navo', req.model.providerType, req.input.kind === 'resume' ? 'resume' : 'message'],
    version: req.meta.appVersion,
    traceMetadata: {
      runId: req.runId,
      thread: req.meta.threadTitle,
      model: req.meta.modelLabel,
      tools: req.tools.length,
      fork: req.fromCheckpointId ? true : undefined,
    },
  })
  return {
    callbacks: [handler],
    finish: async () => {
      await Promise.race([processor.forceFlush(), new Promise((r) => setTimeout(r, 8000))]).catch(() => undefined)
      const traceId = handler.last_trace_id
      return traceId && cfg.projectId ? `${cfg.baseUrl}/project/${cfg.projectId}/traces/${traceId}` : undefined
    },
  }
}

export async function shutdownTracing(): Promise<void> {
  await current?.provider.shutdown().catch(() => undefined)
}
