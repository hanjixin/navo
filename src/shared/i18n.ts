import en from './locales/en.json'

/**
 * Interface language. The Chinese text is the key; locales/en.json maps it to English. Missing
 * translations fall back to the Chinese (scripts/i18n-check.mjs keeps them from going missing).
 */
export type Language = 'zh' | 'en'

const DICTS: Record<Language, Record<string, string>> = { zh: {}, en }
let current: Language = 'zh'

export function setLanguage(lang: Language): void {
  current = lang
}

export const language = (): Language => current

/** Translates; {{name}} placeholders are filled from `vars`. */
export function t(key: string, vars?: Record<string, unknown>): string {
  const s = DICTS[current][key] ?? key
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? '')) : s
}

/** Marks text translated later, where it is shown (module-level definitions in the main process). */
export const tk = (key: string) => key
