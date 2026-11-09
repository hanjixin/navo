import { create } from 'zustand'
import type { AgentRuntimeInfo } from '@shared/agent-runtime'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface RuntimesState {
  runtimes: AgentRuntimeInfo[] | undefined
  error: string | null
  load(): Promise<void>
}
let request = 0
export const useRuntimes = create<RuntimesState>((set) => ({
  runtimes: undefined,
  error: null,
  load: async () => {
    const current = ++request
    try {
      const runtimes = await call('runtimes.list')
      if (current === request) set({ runtimes, error: null })
    } catch (error) {
      if (current === request) set({ error: errorMessage(error) })
    }
  },
}))
let wired = false
export function wireRuntimeEvents(): void {
  if (wired) return
  wired = true
  on('runtimes.changed', () => void useRuntimes.getState().load())
}
