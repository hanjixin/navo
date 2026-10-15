import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'

/** Tokens of one model call. `input` includes cached tokens, as providers report it. */
export interface TokenUsage {
  input: number
  output: number
  cached: number
}

interface UsageMetadata {
  input_tokens?: number
  output_tokens?: number
  input_token_details?: { cache_read?: number }
}

/** Reads the usage a provider reported for a call (LangChain's usage_metadata, or the older tokenUsage). */
export function usageOf(output: LLMResult): TokenUsage | null {
  const gen = output.generations?.[0]?.[0] as { message?: { usage_metadata?: UsageMetadata } } | undefined
  const meta = gen?.message?.usage_metadata
  if (meta && (meta.input_tokens || meta.output_tokens))
    return { input: meta.input_tokens ?? 0, output: meta.output_tokens ?? 0, cached: meta.input_token_details?.cache_read ?? 0 }
  const legacy = (output.llmOutput?.tokenUsage ?? output.llmOutput?.estimatedTokenUsage) as { promptTokens?: number; completionTokens?: number } | undefined
  if (legacy && (legacy.promptTokens || legacy.completionTokens)) return { input: legacy.promptTokens ?? 0, output: legacy.completionTokens ?? 0, cached: 0 }
  return null
}

/** Reports every finished model call's usage. No Electron imports: also used in the agent process. */
export class UsageHandler extends BaseCallbackHandler {
  name = 'navo-usage'
  constructor(private onUsage: (u: TokenUsage) => void) {
    super()
  }
  handleLLMEnd(output: LLMResult): void {
    const u = usageOf(output)
    if (u) this.onUsage(u)
  }
}
