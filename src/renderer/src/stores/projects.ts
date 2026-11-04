import { create } from 'zustand'
import type { Project, ProjectInput, ProjectSummary } from '@shared/types'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

interface ProjectState {
  projects: ProjectSummary[] | undefined
  loading: boolean
  error: string | null
  revision: number
  load: () => Promise<void>
  save: (input: ProjectInput) => Promise<Project>
  remove: (id: string) => Promise<void>
}
let request = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined
export const useProjects = create<ProjectState>((set, get) => ({
  projects: undefined,
  loading: false,
  error: null,
  revision: 0,
  load: async () => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer)
      refreshTimer = undefined
      set((s) => ({ revision: s.revision + 1 }))
    }
    const current = ++request
    set({ loading: true })
    try {
      const projects = await call('projects.list')
      if (current === request) set({ projects, error: null })
    } catch (e) {
      if (current === request) set({ error: errorMessage(e) })
    } finally {
      if (current === request) set({ loading: false })
    }
  },
  save: async (input) => {
    const project = await call('projects.save', input)
    await get().load()
    return project
  },
  remove: async (id) => {
    await call('projects.delete', id)
    await get().load()
  },
}))
let wired = false
export function wireProjectEvents(): void {
  if (wired) return
  wired = true
  const refresh = () => {
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      useProjects.setState((s) => ({ revision: s.revision + 1 }))
      void useProjects.getState().load()
    }, 50)
  }
  on('projects.changed', refresh)
  on('threads.changed', refresh)
  on('outputs.changed', refresh)
}
