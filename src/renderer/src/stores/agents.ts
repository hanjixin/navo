import { create } from 'zustand'
import type { AgentProfile, AgentProfileInput } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface AgentsState {
  agents: AgentProfile[] | undefined
  loading: boolean
  error: string | null
  load: () => Promise<void>
  save: (input: AgentProfileInput) => Promise<AgentProfile>
  remove: (id: string) => Promise<void>
}

let request = 0
export const useAgents = create<AgentsState>((set, get) => ({
  agents: undefined,
  loading: false,
  error: null,
  load: async () => {
    const current = ++request
    set({ loading: true })
    try {
      const agents = await call('agents.list')
      if (current === request) set({ agents, error: null })
    } catch (error) {
      if (current === request) set({ error: errorMessage(error) })
    } finally {
      if (current === request) set({ loading: false })
    }
  },
  save: async (input) => {
    const agent = await call('agents.save', input)
    await get().load()
    return agent
  },
  remove: async (id) => {
    await call('agents.delete', id)
    await get().load()
  },
}))

let wired = false
export function wireAgentEvents(): void {
  if (wired) return
  wired = true
  on('agents.changed', () => void useAgents.getState().load())
}
