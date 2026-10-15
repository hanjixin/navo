import type { ModelPricing } from './types'

/**
 * Reference prices per million tokens, matched by model name. Providers change prices; these only
 * fill in the form, and the user can edit them. More specific patterns come first.
 */
const PRESETS: { match: RegExp; pricing: ModelPricing }[] = [
  // DeepSeek (V3.2 and later: one price for chat and reasoner)
  { match: /deepseek/i, pricing: { input: 2, cachedInput: 0.2, output: 3, currency: 'CNY' } },
  // OpenAI
  { match: /gpt-5[\w.-]*-nano/i, pricing: { input: 0.05, cachedInput: 0.005, output: 0.4, currency: 'USD' } },
  { match: /gpt-5[\w.-]*-mini/i, pricing: { input: 0.25, cachedInput: 0.025, output: 2, currency: 'USD' } },
  { match: /gpt-5/i, pricing: { input: 1.25, cachedInput: 0.125, output: 10, currency: 'USD' } },
  { match: /gpt-4\.1-nano/i, pricing: { input: 0.1, cachedInput: 0.025, output: 0.4, currency: 'USD' } },
  { match: /gpt-4\.1-mini/i, pricing: { input: 0.4, cachedInput: 0.1, output: 1.6, currency: 'USD' } },
  { match: /gpt-4\.1/i, pricing: { input: 2, cachedInput: 0.5, output: 8, currency: 'USD' } },
  { match: /gpt-4o-mini/i, pricing: { input: 0.15, cachedInput: 0.075, output: 0.6, currency: 'USD' } },
  { match: /gpt-4o/i, pricing: { input: 2.5, cachedInput: 1.25, output: 10, currency: 'USD' } },
  { match: /o4-mini/i, pricing: { input: 1.1, cachedInput: 0.275, output: 4.4, currency: 'USD' } },
  { match: /\bo3\b/i, pricing: { input: 2, cachedInput: 0.5, output: 8, currency: 'USD' } },
  // Anthropic
  { match: /claude-(opus-4-[5-9]|opus-[5-9])/i, pricing: { input: 5, cachedInput: 0.5, output: 25, currency: 'USD' } },
  { match: /claude-opus/i, pricing: { input: 15, cachedInput: 1.5, output: 75, currency: 'USD' } },
  { match: /claude-sonnet|claude-3-[57]-sonnet/i, pricing: { input: 3, cachedInput: 0.3, output: 15, currency: 'USD' } },
  { match: /claude-haiku-4|claude-haiku-[5-9]/i, pricing: { input: 1, cachedInput: 0.1, output: 5, currency: 'USD' } },
  { match: /claude-3-5-haiku|claude-haiku/i, pricing: { input: 0.8, cachedInput: 0.08, output: 4, currency: 'USD' } },
  // Qwen (DashScope), Kimi
  { match: /qwen-max/i, pricing: { input: 2.4, output: 9.6, currency: 'CNY' } },
  { match: /qwen-plus/i, pricing: { input: 0.8, output: 2, currency: 'CNY' } },
  { match: /qwen-turbo|qwen-flash/i, pricing: { input: 0.3, output: 0.6, currency: 'CNY' } },
  { match: /kimi-k2/i, pricing: { input: 4, cachedInput: 1, output: 16, currency: 'CNY' } },
]

export function presetPricing(model: string): ModelPricing | null {
  return PRESETS.find((p) => p.match.test(model))?.pricing ?? null
}

export const CURRENCY_SYMBOL: Record<ModelPricing['currency'], string> = { CNY: '¥', USD: '$' }

/**
 * Estimated cost of a call. `input` includes cached tokens (as providers report it); cached tokens
 * are billed at the cached price when there is one.
 */
export function costOf(u: { input: number; output: number; cached: number }, p: ModelPricing | null | undefined): number | null {
  if (!p) return null
  const cached = Math.min(u.cached, u.input)
  const cachedPrice = p.cachedInput ?? p.input
  return ((u.input - cached) * p.input + cached * cachedPrice + u.output * p.output) / 1_000_000
}

export function formatCost(amount: number, currency: ModelPricing['currency']): string {
  const s = CURRENCY_SYMBOL[currency]
  if (amount === 0) return `${s}0`
  if (amount < 0.01) return `<${s}0.01`
  return `${s}${amount < 100 ? amount.toFixed(2) : Math.round(amount).toLocaleString()}`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}
