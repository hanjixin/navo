import type { BaseMessage } from '@langchain/core/messages'
import type { ActionRequest, PendingInterrupt, Todo, UIMessage } from '@shared/types'

type Block = { type?: string; text?: string; image_url?: string | { url: string }; source_type?: string; url?: string; data?: string; mimeType?: string }

/** Extracts thinking / reasoning text from content blocks (Anthropic `thinking`, OpenAI `reasoning` summaries). */
export function reasoningOf(content: unknown, extra?: Record<string, unknown>): string {
  let out = ''
  if (Array.isArray(content)) {
    for (const b of content as (Block & { thinking?: string; reasoning?: string; summary?: { text?: string }[] })[]) {
      if (b.type === 'thinking') out += b.thinking ?? ''
      else if (b.type === 'reasoning') out += b.reasoning ?? (b.summary ?? []).map((x) => x.text ?? '').join('\n')
    }
  }
  const r = extra?.reasoning_content ?? (extra?.reasoning as { summary?: { text?: string }[] } | undefined)?.summary?.map((x) => x.text ?? '').join('\n')
  if (!out && typeof r === 'string') out = r
  return out
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Block[]).map((b) => (typeof b === 'string' ? b : b.type === 'text' || b.type === 'output_text' ? (b.text ?? '') : '')).join('')
  }
  return ''
}

function imagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return (content as Block[])
    .flatMap((b) => {
      if (b.type === 'image_url') return [typeof b.image_url === 'string' ? b.image_url : (b.image_url?.url ?? '')]
      if (b.type === 'image' && b.data) return [`data:${b.mimeType ?? 'image/png'};base64,${b.data}`]
      if (b.type === 'image' && b.url) return [b.url]
      return []
    })
    .filter(Boolean)
}

function typeOf(m: BaseMessage): string {
  const anyM = m as unknown as { type?: string; _getType?: () => string; getType?: () => string }
  return anyM.type ?? anyM.getType?.() ?? anyM._getType?.() ?? ''
}

const TOOL_RESULT_UI_LIMIT = 6000

export function toUIMessage(m: BaseMessage, ns = ''): UIMessage | null {
  const t = typeOf(m)
  const id = m.id ?? `${t}-${Math.random().toString(36).slice(2)}`
  if (t === 'human') {
    const extra = (
      m as unknown as {
        additional_kwargs?: { attachments?: UIMessage['attachments']; userText?: string; attachmentImages?: number; memories?: UIMessage['memories'] }
      }
    ).additional_kwargs
    return {
      id,
      role: 'user',
      content: extra?.userText ?? textOf(m.content),
      images: imagesOf(m.content).slice(extra?.attachmentImages ?? 0),
      ...(extra?.attachments?.length ? { attachments: extra.attachments } : {}),
      ...(extra?.memories?.length ? { memories: extra.memories } : {}),
      ns,
    }
  }
  if (t === 'ai') {
    const ai = m as unknown as { tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[]; additional_kwargs?: Record<string, unknown> }
    const reasoning = reasoningOf(m.content, ai.additional_kwargs)
    return {
      id,
      role: 'assistant',
      content: textOf(m.content),
      ...(reasoning ? { reasoning } : {}),
      toolCalls: (ai.tool_calls ?? []).map((c) => ({ id: c.id ?? '', name: c.name, args: c.args })),
      ns,
    }
  }
  if (t === 'tool') {
    const tm = m as unknown as { tool_call_id: string; name?: string; status?: 'success' | 'error' }
    const text = textOf(m.content) || (Array.isArray(m.content) ? '' : String(m.content ?? ''))
    return {
      id,
      role: 'tool',
      content: text.length > TOOL_RESULT_UI_LIMIT ? text.slice(0, TOOL_RESULT_UI_LIMIT) + '\n…(已截断)' : text,
      images: imagesOf(m.content),
      toolCallId: tm.tool_call_id,
      toolName: tm.name,
      status: tm.status ?? (/^(Error|错误)/.test(text) ? 'error' : 'success'),
      ns,
    }
  }
  return null
}

export function toTodos(v: unknown): Todo[] | null {
  if (!Array.isArray(v)) return null
  return v.map((t: { content?: string; status?: Todo['status'] }) => ({ content: t.content ?? '', status: t.status ?? 'pending' }))
}

interface HITLValue {
  actionRequests?: ActionRequest[]
  reviewConfigs?: { actionName: string; allowedDecisions: ('approve' | 'edit' | 'reject')[] }[]
}

export function toPendingInterrupt(raw: unknown): PendingInterrupt | null {
  const list = Array.isArray(raw) ? raw : [raw]
  const first = list[0] as { id?: string; value?: HITLValue } | undefined
  if (!first?.value?.actionRequests) return null
  const reqs = first.value.actionRequests
  return {
    id: first.id ?? 'interrupt',
    actionRequests: reqs,
    allowedDecisions: reqs.map((r) => first.value!.reviewConfigs?.find((c) => c.actionName === r.name)?.allowedDecisions ?? ['approve', 'reject']),
  }
}
