import { useCallback } from 'react'
import { matchPath, useLocation, useSearchParams } from 'react-router'
import { useBrowser } from '@/stores/browser'
import { sidebarCollapsed, SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED, useLayout } from '@/stores/layout'
import { useProjects } from '@/stores/projects'
import { currentSearchParams } from '@/lib/routes'

export function useWorkspacePanel() {
  const [params, setParams] = useSearchParams()
  const { pathname } = useLocation()
  const projectId = matchPath('/projects/:projectId/*', pathname)?.params.projectId
  const projects = useProjects((s) => s.projects)
  const hasProject = !!projectId && (!projects || projects.some((project) => project.id === projectId))
  const artifactId = params.get('artifact')
  const file = hasProject ? params.get('file') || null : null
  const requested = params.get('panel')
  const browserOpen = useBrowser((s) => s.open)
  const windowWidth = useLayout((s) => s.windowWidth)
  const collapsed = useLayout(sidebarCollapsed)
  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED
  const available = windowWidth - sidebarWidth
  const context = hasProject || !!artifactId
  const selected =
    requested === 'browser' && browserOpen
      ? 'browser'
      : requested === 'project' && hasProject
        ? 'project'
        : requested === 'artifacts' && hasProject
          ? 'artifacts'
          : file
            ? 'file'
            : artifactId
              ? 'artifact'
              : hasProject
                ? 'project'
                : 'browser'
  const overlay = available < (selected === 'project' || selected === 'artifacts' ? 780 : 1000)
  const visible =
    requested !== 'closed' &&
    (selected === 'browser' ? browserOpen : !!(file || artifactId || requested === 'project' || requested === 'artifacts') || !overlay)
  const close = useCallback(() => {
    const next = currentSearchParams()
    useLayout.getState().setWorkspaceLastPanel(next.get('panel'))
    if (!context) {
      useBrowser.getState().setOpen(false)
      next.delete('panel')
    } else next.set('panel', 'closed')
    setParams(next, { replace: true })
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="toggle-workspace"]')?.focus())
  }, [context, setParams])
  const restore = useCallback(() => {
    const next = currentSearchParams()
    const previous = useLayout.getState().workspaceLastPanel
    if (!context) {
      next.delete('panel')
      useBrowser.getState().setOpen(true)
    } else if (previous && previous !== 'closed') {
      next.set('panel', previous)
      if (previous === 'browser') useBrowser.getState().setOpen(true)
    } else if (next.has('file') || next.has('artifact')) next.delete('panel')
    else next.set('panel', 'project')
    setParams(next, { replace: true })
  }, [context, setParams])
  return { projectId, hasProject, artifactId, file, selected, visible, overlay, available, sidebarWidth, context, close, restore }
}
