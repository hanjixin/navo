import type { MacroStep } from '@shared/types'

export interface RawEvent {
  type: 'click' | 'type' | 'select' | 'press' | 'navigate'
  selectors?: string[]
  value?: string
  key?: string
  label?: string
  url?: string
  secret?: boolean
  t: number
}

let counter = 0
const sid = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`

/**
 * Appends a raw recorder event to the step list, merging noise:
 * consecutive typing into the same field collapses into one step and navigations caused by
 * a click/Enter just before are dropped (playback reproduces them naturally).
 */
export function appendEvent(steps: MacroStep[], e: RawEvent, lastActionAt: number): MacroStep[] {
  const last = steps.at(-1)
  if (e.type === 'navigate') {
    if (e.t - lastActionAt < 2500) return steps
    if (last?.type === 'navigate' && last.url === e.url) return steps
    return [...steps, { id: sid(), type: 'navigate', url: e.url, label: e.url }]
  }
  if (e.type === 'type' && last?.type === 'type' && same(last.selectors, e.selectors)) {
    return [...steps.slice(0, -1), { ...last, value: e.secret ? '{{password}}' : e.value }]
  }
  if (e.type === 'press' && e.key === 'Tab' && last?.type === 'type') return steps
  const step: MacroStep = {
    id: sid(),
    type: e.type,
    selectors: e.selectors,
    label: e.label,
    ...(e.type === 'type' || e.type === 'select' ? { value: e.secret ? '{{password}}' : e.value } : {}),
    ...(e.type === 'press' ? { key: e.key } : {}),
  }
  return [...steps, step]
}

function same(a?: string[], b?: string[]): boolean {
  return !!a?.length && !!b?.length && a[0] === b[0]
}

/** Replaces {{name}} placeholders with params (falls back to defaults). */
export function fillTemplate(s: string | undefined, params: Record<string, string>): string {
  return (s ?? '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k: string) => params[k] ?? '')
}

/** Extracts placeholder names used by the steps. */
export function placeholders(steps: MacroStep[]): string[] {
  const out = new Set<string>()
  for (const s of steps) {
    for (const v of [s.value, s.url]) for (const m of (v ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) out.add(m[1])
  }
  return [...out]
}
