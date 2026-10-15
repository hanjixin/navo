import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/layout/app-shell'
import { Onboarding } from '@/components/onboarding/onboarding'
import { useTheme } from '@/hooks/use-theme'
import { useSettings } from '@/stores/settings'
import { wireChatEvents } from '@/stores/chat'
import { wireMemoryEvents } from '@/stores/memory'
import { wireSkillEvents } from '@/stores/skills'
import { wireFlowEvents } from '@/stores/flows'
import { wireBrowserEvents } from '@/stores/browser'
import { ChatPage } from '@/pages/chat'
import { TasksPage } from '@/pages/tasks'
import { FilesPage } from '@/pages/files'
import { SkillsPage } from '@/pages/skills'
import { ConnectorsPage } from '@/pages/connectors'
import { McpPage } from '@/pages/mcp'
import { MemoryPage } from '@/pages/memory'
import { PluginsPage } from '@/pages/plugins'
import { MacrosPage } from '@/pages/macros'
import { ModelsPage } from '@/pages/models'
import { DevPage } from '@/pages/dev'
import { SettingsPage } from '@/pages/settings'
import { QuickPage } from '@/pages/quick'

/** this renderer is the quick window (global shortcut), not the main window */
const isQuick = window.location.hash.startsWith('#/quick')

export function App() {
  useTheme()
  const load = useSettings((s) => s.load)
  const settings = useSettings((s) => s.settings)
  useEffect(() => {
    void load()
    wireChatEvents()
    // the quick window only needs the conversation; the app's toasts belong to the main window
    if (isQuick) return
    wireBrowserEvents()
    wireMemoryEvents()
    wireSkillEvents()
    wireFlowEvents()
  }, [load])

  return (
    <TooltipProvider>
      <HashRouter>
        {/* until settings load we render nothing (avoids flashing the app before onboarding) */}
        {!settings ? null : isQuick ? (
          <Routes>
            <Route path="/quick" element={<QuickPage />} />
          </Routes>
        ) : !settings.onboarded ? (
          <Onboarding />
        ) : (
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/connectors" element={<ConnectorsPage />} />
              <Route path="/mcp" element={<McpPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/plugins" element={<PluginsPage />} />
              <Route path="/macros" element={<MacrosPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/dev" element={<DevPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        )}
      </HashRouter>
      <Toaster />
    </TooltipProvider>
  )
}
