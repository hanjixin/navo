import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelConfig, ModelInput, Provider, ProviderInput, ProviderType } from '@shared/types'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { secrets } from '../core/secrets'
import { buildChatModel, type ResolvedModel } from './factory'

interface ProviderRow {
  id: string
  type: ProviderType
  name: string
  base_url: string | null
  headers: string | null
  created_at: number
}

interface ModelRow {
  id: string
  provider_id: string
  model: string
  display_name: string
  context_window: number | null
  supports_tools: number
  supports_vision: number
  temperature: number | null
  max_tokens: number | null
  reasoning_effort: ModelConfig['reasoningEffort']
  is_default: number
}

const keyOf = (providerId: string) => `provider:${providerId}`

function toProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    baseURL: r.base_url,
    headers: json.parse(r.headers),
    hasKey: secrets.has(keyOf(r.id)),
    createdAt: r.created_at,
  }
}

function toModel(r: ModelRow): ModelConfig {
  return {
    id: r.id,
    providerId: r.provider_id,
    model: r.model,
    displayName: r.display_name,
    contextWindow: r.context_window,
    supportsTools: !!r.supports_tools,
    supportsVision: !!r.supports_vision,
    temperature: r.temperature,
    maxTokens: r.max_tokens,
    reasoningEffort: r.reasoning_effort,
    isDefault: !!r.is_default,
  }
}

export const providers = {
  list(): Provider[] {
    return (db().prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[]).map(toProvider)
  },
  get(id: string): Provider {
    const row = db().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
    if (!row) throw new Error('提供方不存在')
    return toProvider(row)
  },
  save(input: ProviderInput): Provider {
    const id = input.id ?? newId()
    db()
      .prepare(
        `INSERT INTO providers(id, type, name, base_url, headers, created_at) VALUES(@id, @type, @name, @baseURL, @headers, @now)
         ON CONFLICT(id) DO UPDATE SET type = @type, name = @name, base_url = @baseURL, headers = @headers`,
      )
      .run({ id, type: input.type, name: input.name, baseURL: input.baseURL || null, headers: json.str(input.headers), now: Date.now() })
    if (input.apiKey !== undefined) {
      if (input.apiKey) secrets.set(keyOf(id), input.apiKey)
      else secrets.delete(keyOf(id))
    }
    return this.get(id)
  },
  delete(id: string): void {
    db().prepare('DELETE FROM providers WHERE id = ?').run(id)
    secrets.delete(keyOf(id))
  },
  apiKey(id: string): string | null {
    return secrets.get(keyOf(id))
  },
  /**
   * Lists remote model ids. Compatible providers put the list in different places (e.g. DeepSeek's
   * Anthropic-compatible base https://api.deepseek.com/anthropic serves models at /models on the
   * origin), so several URL / auth combinations are tried in order.
   */
  async fetchModels(id: string): Promise<string[]> {
    const p = this.get(id)
    const key = this.apiKey(id) ?? ''
    const isAnthropic = p.type === 'anthropic'
    const base = (p.baseURL || (isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '')
    const origin = new URL(base).origin
    const urls = [
      ...new Set([
        isAnthropic ? `${base.replace(/\/v1$/, '')}/v1/models?limit=200` : `${base}/models`,
        `${base}/models`,
        `${base}/v1/models`,
        `${origin}/v1/models`,
        `${origin}/models`,
      ]),
    ]
    const auths: Record<string, string>[] = isAnthropic
      ? [{ 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { Authorization: `Bearer ${key}` }]
      : [{ Authorization: `Bearer ${key}` }]
    const tried: string[] = []
    for (const url of urls) {
      for (const auth of auths) {
        try {
          const res = await fetch(url, { headers: { ...auth, ...(p.headers ?? {}) }, signal: AbortSignal.timeout(10000) })
          if (!res.ok) {
            tried.push(`${url} → ${res.status}`)
            continue
          }
          const body = (await res.json()) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] }
          const ids = (body.data ?? body.models ?? []).map((m) => m.id ?? (m as { name?: string }).name ?? '').filter(Boolean)
          if (ids.length) return [...new Set(ids)].sort()
          tried.push(`${url} → 空列表`)
        } catch (err) {
          tried.push(`${url} → ${(err as Error).message}`)
        }
      }
    }
    throw new Error(`无法获取模型列表，可以直接手动填写模型 ID。\n尝试过：\n${tried.join('\n')}`)
  },
}

export const models = {
  list(): ModelConfig[] {
    return (db().prepare('SELECT * FROM models ORDER BY is_default DESC, display_name').all() as ModelRow[]).map(toModel)
  },
  get(id: string): ModelConfig | null {
    const row = db().prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined
    return row ? toModel(row) : null
  },
  default(): ModelConfig | null {
    const row = db().prepare('SELECT * FROM models ORDER BY is_default DESC LIMIT 1').get() as ModelRow | undefined
    return row ? toModel(row) : null
  },
  save(input: ModelInput): ModelConfig {
    const id = input.id ?? newId()
    const isFirst = !db().prepare('SELECT 1 FROM models LIMIT 1').get()
    db()
      .prepare(
        `INSERT INTO models(id, provider_id, model, display_name, context_window, supports_tools, supports_vision, temperature, max_tokens, reasoning_effort, is_default)
         VALUES(@id, @providerId, @model, @displayName, @contextWindow, @supportsTools, @supportsVision, @temperature, @maxTokens, @reasoningEffort, @isDefault)
         ON CONFLICT(id) DO UPDATE SET provider_id = @providerId, model = @model, display_name = @displayName, context_window = @contextWindow,
           supports_tools = @supportsTools, supports_vision = @supportsVision, temperature = @temperature, max_tokens = @maxTokens,
           reasoning_effort = @reasoningEffort`,
      )
      .run({
        id,
        providerId: input.providerId,
        model: input.model,
        displayName: input.displayName || input.model,
        contextWindow: input.contextWindow ?? null,
        supportsTools: input.supportsTools ? 1 : 0,
        supportsVision: input.supportsVision ? 1 : 0,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        isDefault: isFirst || input.isDefault ? 1 : 0,
      })
    if (input.isDefault) this.setDefault(id)
    return this.get(id)!
  },
  delete(id: string): void {
    db().prepare('DELETE FROM models WHERE id = ?').run(id)
  },
  setDefault(id: string): void {
    db().transaction(() => {
      db().prepare('UPDATE models SET is_default = 0').run()
      db().prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(id)
    })()
  },
}

/** Resolves a stored model (or the default) into a self-contained config with the decrypted key. */
export function resolveModel(modelId?: string | null): ResolvedModel {
  const cfg = (modelId && models.get(modelId)) || models.default()
  if (!cfg) throw new Error('尚未配置模型，请先在「模型」页面添加提供方和模型')
  const p = providers.get(cfg.providerId)
  return {
    providerType: p.type,
    model: cfg.model,
    apiKey: providers.apiKey(p.id) ?? undefined,
    baseURL: p.baseURL,
    headers: p.headers,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    supportsVision: cfg.supportsVision,
  }
}

export function createChatModel(modelId?: string | null): BaseChatModel {
  return buildChatModel(resolveModel(modelId))
}

export async function testModel(id: string): Promise<{ ok: boolean; latencyMs: number; reply?: string; error?: string }> {
  const started = Date.now()
  try {
    const model = createChatModel(id)
    const res = await model.invoke([{ role: 'user', content: 'Reply with the single word: pong' }])
    const reply = typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
    return { ok: true, latencyMs: Date.now() - started, reply: reply.slice(0, 200) }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
  }
}
