import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { RuntimeModel } from '../agent-runtime/contracts'
import type { ModelAdapter } from '../agent-runtime/model-adapter'

export function piModel(config: RuntimeModel): Model<Api> {
  const api =
    config.providerType === 'anthropic' ? 'anthropic-messages' : config.providerType === 'openai-responses' ? 'openai-responses' : 'openai-completions'
  return {
    id: config.model,
    name: config.model,
    api,
    provider: config.providerType === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: config.baseURL || (config.providerType === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
    input: config.supportsVision ? ['text', 'image'] : ['text'],
    reasoning: !!config.reasoningEffort,
    contextWindow: 128000,
    maxTokens: config.maxTokens ?? 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: config.headers ?? undefined,
  }
}
export function piStream(config: RuntimeModel): StreamFn {
  return (model, context, options) =>
    streamSimple(model, context, {
      ...options,
      apiKey: config.apiKey || 'not-needed',
      headers: config.headers ?? undefined,
      temperature: config.temperature ?? undefined,
      maxTokens: config.maxTokens ?? 8192,
      reasoning: config.reasoningEffort ?? undefined,
    })
}

export const piModelAdapter: ModelAdapter<Model<Api>, StreamFn> = {
  model: piModel,
  stream: piStream,
}
