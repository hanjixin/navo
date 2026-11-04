import { create } from 'zustand'
import type { ModelConfig, Provider } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface ModelsState {
  providers: Provider[] | undefined
  /** Full configuration list, including disabled models, for management. */
  models: ModelConfig[] | undefined
  activeModels: ModelConfig[] | undefined
  error: string | null
  load: () => Promise<void>
}
let request = 0
export const useModels = create<ModelsState>((set) => ({
  providers: undefined,
  models: undefined,
  activeModels: undefined,
  error: null,
  load: async () => {
    const current = ++request
    try {
      const [providers, models] = await Promise.all([call('providers.list'), call('models.list')])
      if (current === request) set({ providers, models, activeModels: models.filter((model) => model.enabled !== false), error: null })
    } catch (e) {
      if (current === request) set({ error: errorMessage(e) })
    }
  },
}))

let wired = false
export function wireModelEvents(): void {
  if (wired) return
  wired = true
  on('models.changed', () => void useModels.getState().load())
}
