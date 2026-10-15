import { describe, expect, it } from 'vitest'
import type { LLMResult } from '@langchain/core/outputs'
import { costOf, formatCost, formatTokens, presetPricing } from '../src/shared/pricing'
import { usageOf } from '../src/main/models/usage-callback'

const result = (message: unknown, llmOutput?: Record<string, unknown>) => ({ generations: [[{ text: '', message }]], llmOutput }) as unknown as LLMResult

describe('usageOf', () => {
  it('reads usage_metadata, including cache hits', () => {
    expect(usageOf(result({ usage_metadata: { input_tokens: 1200, output_tokens: 80, input_token_details: { cache_read: 1000 } } }))).toEqual({
      input: 1200,
      output: 80,
      cached: 1000,
    })
  })
  it('falls back to the older tokenUsage; nothing reported → null', () => {
    expect(usageOf(result({}, { tokenUsage: { promptTokens: 10, completionTokens: 5 } }))).toEqual({ input: 10, output: 5, cached: 0 })
    expect(usageOf(result({}))).toBeNull()
    expect(usageOf({ generations: [] } as unknown as LLMResult)).toBeNull()
  })
})

describe('pricing', () => {
  it('reference prices by model name, the most specific first', () => {
    expect(presetPricing('deepseek-chat')?.currency).toBe('CNY')
    expect(presetPricing('gpt-4o-mini')?.input).toBe(0.15)
    expect(presetPricing('gpt-4o-2024-08-06')?.input).toBe(2.5)
    expect(presetPricing('claude-sonnet-4-5')?.output).toBe(15)
    expect(presetPricing('my-local-llama')).toBeNull()
  })
  it('cost: cached input at the cached price, the rest at the input price', () => {
    const p = { input: 2, cachedInput: 0.2, output: 3, currency: 'CNY' as const }
    // 1M input of which 0.5M cached, 0.1M output → 0.5×2 + 0.5×0.2 + 0.1×3
    expect(costOf({ input: 1_000_000, cached: 500_000, output: 100_000 }, p)).toBeCloseTo(1.4)
    expect(costOf({ input: 1000, cached: 0, output: 0 }, { input: 2, output: 3, currency: 'USD' })).toBeCloseTo(0.002)
    expect(costOf({ input: 1, cached: 0, output: 1 }, null)).toBeNull()
  })
  it('formats amounts and token counts compactly', () => {
    expect(formatCost(0, 'CNY')).toBe('¥0')
    expect(formatCost(0.004, 'USD')).toBe('<$0.01')
    expect(formatCost(12.345, 'CNY')).toBe('¥12.35')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1500)).toBe('1.5K')
    expect(formatTokens(250_000)).toBe('250K')
    expect(formatTokens(3_200_000)).toBe('3.20M')
  })
})
