import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelConfig, ModelInput, ModelPricing, Provider, ProviderInput, ProviderType } from '@shared/types'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { secrets } from '../core/secrets'
import { buildChatModel, type ResolvedModel } from './factory'
import { t } from '@shared/i18n'

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
  enabled: number
  is_default: number
  pricing: string | null
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
    enabled: !!r.enabled,
    pricing: json.parse<ModelPricing>(r.pricing),
  }
}

export const providers = {
  list(): Provider[] {
    return (db().prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[]).map(toProvider)
  },
  get(id: string): Provider {
    const row = db().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
    if (!row) throw new Error(t('提供方不存在'))
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
    models.ensureDefault()
    emit('models.changed')
  },
  apiKey(id: string): string | null {
    return secrets.get(keyOf(id))
  },
  async importModels(id: string): Promise<{ imported: number; existing: number; total: number }> {
    const ids = [...new Set((await this.fetchModels(id)).map((value) => value.trim()).filter(Boolean))]
    const result = db().transaction(() => {
      this.get(id)
      let imported = 0
      for (const model of ids) {
        if (db().prepare('SELECT 1 FROM models WHERE provider_id=? AND model=?').get(id, model)) continue
        db()
          .prepare('INSERT INTO models(id,provider_id,model,display_name,supports_tools,supports_vision,enabled,is_default) VALUES(?,?,?,?,1,0,0,0)')
          .run(newId(), id, model, model)
        imported++
      }
      return { imported, existing: ids.length - imported, total: ids.length }
    })()
    emit('models.changed')
    return result
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
          const ids: string[] = []
          const cursors = new Set<string>()
          let pageUrl = url
          for (;;) {
            const res = await fetch(pageUrl, { headers: { ...auth, ...(p.headers ?? {}) }, signal: AbortSignal.timeout(10000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = (await res.json()) as {
              data?: { id?: string; name?: string }[]
              models?: { id?: string; name?: string }[]
              has_more?: boolean
              last_id?: string
            }
            const page = (body.data ?? body.models ?? []).map((m) => m.id ?? m.name ?? '').filter((id) => typeof id === 'string' && !!id.trim())
            ids.push(...page)
            if (!body.has_more) break
            const cursor = body.last_id ?? page.at(-1)
            if (!cursor || cursors.has(cursor)) throw new Error('Invalid model pagination cursor')
            cursors.add(cursor)
            const next = new URL(url)
            next.searchParams.set('after_id', cursor)
            pageUrl = next.toString()
          }
          if (ids.length) return [...new Set(ids)].sort()
          tried.push(`${url} → 空列表`)
        } catch (err) {
          tried.push(`${url} → ${(err as Error).message}`)
        }
      }
    }
    throw new Error(t('无法获取模型列表，可以直接手动填写模型 ID。\n尝试过：\n{{v0}}', { v0: tried.join('\n') }))
  },
}

export const models = {
  list(): ModelConfig[] {
    return (db().prepare('SELECT * FROM models ORDER BY is_default DESC, display_name, id').all() as ModelRow[]).map(toModel)
  },
  get(id: string): ModelConfig | null {
    const row = db().prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined
    return row ? toModel(row) : null
  },
  default(): ModelConfig | null {
    const row = db().prepare('SELECT * FROM models WHERE enabled=1 ORDER BY is_default DESC, display_name, id LIMIT 1').get() as ModelRow | undefined
    return row ? toModel(row) : null
  },
  save(input: ModelInput): ModelConfig {
    const duplicate = db().prepare('SELECT id FROM models WHERE provider_id=? AND model=? ORDER BY id LIMIT 1').get(input.providerId, input.model) as
      { id: string } | undefined
    if (input.id && duplicate && duplicate.id !== input.id) throw new Error(t('该提供方下已存在此模型，请编辑已有模型'))
    const id = input.id ?? duplicate?.id ?? newId()
    const existing = this.get(id)
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error(t('模型启用状态必须是布尔值'))
    const enabled = input.enabled ?? existing?.enabled ?? true
    if (input.isDefault && !enabled) throw new Error(t('请先启用模型再设为默认'))
    db()
      .prepare(
        `INSERT INTO models(id, provider_id, model, display_name, context_window, supports_tools, supports_vision, temperature, max_tokens, reasoning_effort, is_default, enabled)
         VALUES(@id, @providerId, @model, @displayName, @contextWindow, @supportsTools, @supportsVision, @temperature, @maxTokens, @reasoningEffort, @isDefault, @enabled)
         ON CONFLICT(id) DO UPDATE SET provider_id = @providerId, model = @model, display_name = @displayName, context_window = @contextWindow,
           supports_tools = @supportsTools, supports_vision = @supportsVision, temperature = @temperature, max_tokens = @maxTokens,
           reasoning_effort = @reasoningEffort, enabled = @enabled`,
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
        isDefault: enabled && (existing?.isDefault || input.isDefault) ? 1 : 0,
        enabled: enabled ? 1 : 0,
      })
    if (input.isDefault) this.setDefault(id)
    else this.ensureDefault()
    emit('models.changed')
    return this.get(id)!
  },
  delete(id: string): void {
    db().prepare('DELETE FROM models WHERE id = ?').run(id)
    this.ensureDefault()
    emit('models.changed')
  },
  ensureDefault(): void {
    const selected = this.default()
    db().prepare('UPDATE models SET is_default=0 WHERE is_default!=0').run()
    if (selected) db().prepare('UPDATE models SET is_default=1 WHERE id=?').run(selected.id)
  },
  setEnabled(id: string, enabled: boolean): void {
    this.setEnabledMany([id], enabled)
  },
  setEnabledMany(ids: string[], enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error(t('模型启用状态必须是布尔值'))
    const unique = [...new Set(ids)]
    db().transaction(() => {
      for (const id of unique) if (!this.get(id)) throw new Error(t('模型不存在，请重新选择'))
      const update = db().prepare('UPDATE models SET enabled=? WHERE id=?')
      for (const id of unique) update.run(enabled ? 1 : 0, id)
      this.ensureDefault()
    })()
    emit('models.changed')
  },
  affectedTasks(ids: string[]): { id: string; name: string }[] {
    const selected = new Set(ids)
    const defaultId = this.default()?.id
    return (db().prepare('SELECT id, name, model_id FROM tasks').all() as { id: string; name: string; model_id: string | null }[])
      .filter((task) => selected.has(task.model_id ?? defaultId ?? ''))
      .map(({ id, name }) => ({ id, name }))
  },
  setPricing(id: string, pricing: ModelPricing | null): void {
    if (pricing && ![pricing.input, pricing.output, pricing.cachedInput ?? 0].every((n) => Number.isFinite(n) && n >= 0))
      throw new Error(t('价格必须是不小于 0 的数字'))
    db()
      .prepare('UPDATE models SET pricing = ? WHERE id = ?')
      .run(pricing ? json.str(pricing) : null, id)
    emit('models.changed')
  },
  setDefault(id: string): void {
    const model = this.get(id)
    if (!model) throw new Error(t('模型不存在，请重新选择'))
    if (!model.enabled) throw new Error(t('请先启用模型再设为默认'))
    db().transaction(() => {
      db().prepare('UPDATE models SET is_default = 0').run()
      db().prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(id)
    })()
    emit('models.changed')
  },
}

/** Resolves a stored model (or the default) into a self-contained config with the decrypted key. */
export function resolveModel(modelId?: string | null, allowDisabled = false): ResolvedModel {
  const cfg = modelId ? models.get(modelId) : models.default()
  if (!cfg) throw new Error(modelId ? t('模型不存在，请重新选择') : t('没有已启用的模型，请在「模型」页面启用一个模型'))
  if (!cfg.enabled && !allowDisabled) throw new Error(t('当前模型已停用，请重新选择已启用的模型'))
  const p = providers.get(cfg.providerId)
  return {
    id: cfg.id,
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
    const model = buildChatModel(resolveModel(id, true))
    const res = await model.invoke([{ role: 'user', content: 'Reply with the single word: pong' }])
    const reply = typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
    return { ok: true, latencyMs: Date.now() - started, reply: reply.slice(0, 200) }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
  }
}
