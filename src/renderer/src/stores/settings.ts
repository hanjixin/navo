import { create } from 'zustand'
import type { Settings } from '@shared/types'
import { call, on } from '@/lib/ipc'

interface SettingsState {
  settings: Settings | null
  load: () => Promise<void>
  update: (patch: Partial<Settings> & { langsmithApiKey?: string; langfuseSecretKey?: string; mineruToken?: string }) => Promise<void>
}

export const useSettings = create<SettingsState>((set) => {
  // keep in sync with changes made elsewhere (other windows, MCP clients, main process)
  on('settings.changed', (settings) => set({ settings }))
  return {
    settings: null,
    load: async () => set({ settings: await call('settings.get') }),
    update: async (patch) => set({ settings: await call('settings.set', patch) }),
  }
})
