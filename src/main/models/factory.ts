import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelConfig, ProviderType } from '@shared/types'

/** Everything needed to build a chat model, with the API key already decrypted. Safe to send to the agent process. */
export interface ResolvedModel {
  providerType: ProviderType
  model: string
  apiKey?: string
  baseURL?: string | null
  headers?: Record<string, string> | null
  temperature?: number | null
  maxTokens?: number | null
  reasoningEffort?: ModelConfig['reasoningEffort']
  supportsVision: boolean
}

export function buildChatModel(r: ResolvedModel): BaseChatModel {
  const common = {
    model: r.model,
    temperature: r.temperature ?? undefined,
    maxTokens: r.maxTokens ?? undefined,
    streaming: true,
  }
  if (r.providerType === 'anthropic') {
    return new ChatAnthropic({
      ...common,
      apiKey: r.apiKey,
      maxTokens: r.maxTokens ?? 8192,
      clientOptions: { baseURL: r.baseURL || undefined, defaultHeaders: r.headers ?? undefined },
    })
  }
  return new ChatOpenAI({
    ...common,
    apiKey: r.apiKey || 'not-needed',
    useResponsesApi: r.providerType === 'openai-responses',
    reasoning: r.reasoningEffort ? { effort: r.reasoningEffort } : undefined,
    configuration: { baseURL: r.baseURL || undefined, defaultHeaders: r.headers ?? undefined },
  })
}
