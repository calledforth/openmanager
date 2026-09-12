import { useEffect, useState } from 'react'
import { DesktopViewActions } from './providers/desktop-view-actions'
import { ThemeProvider } from '@openmanager/app-core/providers/theme-provider'
import { PlatformCapabilitiesProvider } from './providers/platform-capabilities-provider'
import { SessionStateProvider } from './providers/session-state-provider'
import { ComposerStateProvider } from './providers/composer-state-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveThreadStateProvider } from './providers/active-thread-provider'
import { DesktopPermissionStateProvider } from './providers/permission-provider'
import { DesktopQuestionStateProvider } from './providers/question-provider'
import { DesktopPlanStateProvider } from './providers/plan-provider'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import { ChatWorkspace } from '@openmanager/app-core/components/chat/ChatWorkspace'
import { SidebarSettingsMenu } from './components/sidebar/SidebarSettingsMenu'
import { ConvexTelemetryPanel } from './components/telemetry/ConvexTelemetryPanel'
import { AppChrome } from './components/shell/AppChrome'
import { UpdateNotification } from './components/updates/UpdateNotification'
import { ensureShiki } from '@openmanager/app-core/lib/shiki'

// Warm the grammars at boot so the first code block arrives already
// highlighted instead of rendering plain and then repainting.
void ensureShiki().catch((error) => {
  console.error('Failed to initialize syntax highlighting', error)
})

const sidebarToggleShortcut = window.electronAPI.platform === 'darwin' ? '⌘B' : 'Ctrl+B'

function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [convexOpen, setConvexOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      setSidebarCollapsed((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed(true)}
        settingsMenu={
          <SidebarSettingsMenu convexOpen={convexOpen} onToggleConvex={() => setConvexOpen((v) => !v)} />
        }
        sidebarToggleShortcut={sidebarToggleShortcut}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
        <AppChrome
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />
        <ChatWorkspace />
      </div>
      <ConvexTelemetryPanel open={convexOpen} onOpenChange={setConvexOpen} />
      <UpdateNotification />
    </div>
  )
}

// Providers are ordered by dependency: platform capabilities know nothing of
// sessions; session navigation needs provider startup; the composer needs
// both plus the open draft; the active thread submits turns through all three.
// See docs/application-providers.md.
function App() {
  return (
    <ThemeProvider>
      <PlatformCapabilitiesProvider>
        <SessionStateProvider>
          <ComposerStateProvider>
            <SidebarDataProvider>
              <ActiveThreadStateProvider>
                <DesktopPermissionStateProvider>
                  <DesktopQuestionStateProvider>
                    <DesktopPlanStateProvider>
                      <DesktopViewActions>
                        <AppShell />
                      </DesktopViewActions>
                    </DesktopPlanStateProvider>
                  </DesktopQuestionStateProvider>
                </DesktopPermissionStateProvider>
              </ActiveThreadStateProvider>
            </SidebarDataProvider>
          </ComposerStateProvider>
        </SessionStateProvider>
      </PlatformCapabilitiesProvider>
    </ThemeProvider>
  )
}

export default App
