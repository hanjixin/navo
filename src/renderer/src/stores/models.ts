import { create } from 'zustand'
import type { ModelConfig, Provider } from '@shared/types'
import { call } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface ModelsState {
  providers: Provider[] | undefined
  models: ModelConfig[] | undefined
  error: string | null
  load: () => Promise<void>
}

export const useModels = create<ModelsState>((set) => ({
  providers: undefined,
  models: undefined,
  error: null,
  load: async () => {
    try {
      const [providers, models] = await Promise.all([call('providers.list'), call('models.list')])
      set({ providers, models, error: null })
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },
}))
