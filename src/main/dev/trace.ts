import type { TraceEntry } from '@shared/types'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { Serialized } from '@langchain/core/load/serializable'
import type { BaseMessage } from '@langchain/core/messages'
import type { LLMResult } from '@langchain/core/outputs'

import type Database from 'better-sqlite3'
import { newId } from '../core/id'

const clip = (s: string, n = 20000) => (s.length > n ? s.slice(0, n) + '…' : s)
const str = (v: unknown) => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Records LLM and tool calls into the local `traces` table (developer mode only). */
export class TraceHandler extends BaseCallbackHandler {
  name = 'navo-trace'
  private starts = new Map<string, { t: number; name: string; input: string; kind: TraceEntry['kind'] }>()

  constructor(
    private readonly db: Database.Database,
    private readonly threadId: string,
    private readonly runId: string,
  ) {
    super()
  }

  override handleChatModelStart(llm: Serialized, messages: BaseMessage[][], runId: string, _p?: string, extra?: Record<string, unknown>) {
    const name = (extra?.invocation_params as { model?: string } | undefined)?.model ?? llm.id?.at(-1) ?? 'llm'
    const input = messages[0]?.map((m) => `[${(m as unknown as { type?: string }).type}] ${str(m.content)}`).join('\n\n') ?? ''
    this.starts.set(runId, { t: Date.now(), name: String(name), input: clip(input), kind: 'llm' })
  }

  override handleLLMEnd(output: LLMResult, runId: string) {
    const s = this.starts.get(runId)
    if (!s) return
    this.starts.delete(runId)
    const gen = output.generations?.[0]?.[0] as { message?: BaseMessage; text?: string } | undefined
    const msg = gen?.message as (BaseMessage & { tool_calls?: unknown[]; usage_metadata?: { total_tokens?: number } }) | undefined
    const out = msg ? `${str(msg.content)}${msg.tool_calls?.length ? '\n\ntool_calls: ' + str(msg.tool_calls) : ''}` : (gen?.text ?? '')
    this.write(s, clip(out), msg?.usage_metadata?.total_tokens ?? null)
  }

  override handleLLMError(err: Error, runId: string) {
    const s = this.starts.get(runId)
    if (s) this.write({ ...s, kind: 'error' }, err.message, null)
  }

  override handleToolStart(tool: Serialized, input: string, runId: string, _p?: string, _t?: string[], _m?: Record<string, unknown>, runName?: string) {
    this.starts.set(runId, { t: Date.now(), name: runName ?? tool.id?.at(-1) ?? 'tool', input: clip(input), kind: 'tool' })
  }

  override handleToolEnd(output: unknown, runId: string) {
    const s = this.starts.get(runId)
    if (!s) return
    this.starts.delete(runId)
    const content = (output as { content?: unknown })?.content ?? output
    this.write(s, clip(str(content)), null)
  }

  override handleToolError(err: Error, runId: string) {
    const s = this.starts.get(runId)
    if (s) this.write({ ...s, kind: 'error' }, err.message, null)
  }

  private write(s: { t: number; name: string; input: string; kind: TraceEntry['kind'] }, output: string, tokens: number | null) {
    this.db
      .prepare('INSERT INTO traces(id, thread_id, run_id, kind, name, input, output, duration_ms, tokens, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), this.threadId, this.runId, s.kind, s.name, s.input, output, Date.now() - s.t, tokens, Date.now())
  }
}
