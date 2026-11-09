import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import type { Callbacks } from '@langchain/core/callbacks/manager'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

import type { RuntimeModel } from '../agent-runtime/contracts'

export type ResolvedModel = RuntimeModel

export function buildChatModel(r: ResolvedModel, callbacks?: Callbacks): BaseChatModel {
  const common = {
    model: r.model,
    temperature: r.temperature ?? undefined,
    maxTokens: r.maxTokens ?? undefined,
    streaming: true,
    callbacks,
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
    // token usage of streamed answers (for the usage page)
    streamUsage: true,
    reasoning: r.reasoningEffort ? { effort: r.reasoningEffort } : undefined,
    configuration: { baseURL: r.baseURL || undefined, defaultHeaders: r.headers ?? undefined },
  })
}
