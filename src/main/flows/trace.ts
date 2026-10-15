/**
 * What the agent did in the browser during a run, step by step, with stable selectors for every
 * element it touched — the raw material for a fixed flow that replays without the model.
 */
export interface TraceStep {
  type: 'navigate' | 'click' | 'type' | 'select' | 'press'
  selectors?: string[]
  value?: string
  key?: string
  url: string
  /** accessible name of the element, for people reading the flow */
  label?: string
  /** typed into a password field: the value is not kept */
  secret?: boolean
  at: number
}

const runs = new Map<string, TraceStep[]>()

export const trace = {
  /** A run starts: begin a fresh trace for the conversation. */
  start(threadId: string): void {
    runs.set(threadId, [])
  },
  add(threadId: string | undefined, step: Omit<TraceStep, 'at'>): void {
    if (!threadId) return
    const list = runs.get(threadId)
    if (!list) return
    list.push({ ...step, value: step.secret ? undefined : step.value, at: Date.now() })
  },
  /** The run ended: hand over its trace. */
  take(threadId: string): TraceStep[] {
    const list = runs.get(threadId) ?? []
    runs.delete(threadId)
    return list
  },
  peek(threadId: string): TraceStep[] {
    return runs.get(threadId) ?? []
  },
}
