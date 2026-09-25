import { useEffect, useState } from 'react'
import { DesktopViewActions } from './providers/desktop-view-actions'
import { ThemeProvider } from '@openmanager/app-core/providers/theme-provider'
import { FluidProviders } from '@openmanager/app-core/providers/fluid-provider'
import { CommandPalette } from '@openmanager/app-core/components/command/CommandPalette'
import { PlatformCapabilitiesProvider } from './providers/platform-capabilities-provider'
import { SessionStateProvider } from './providers/session-state-provider'
import { ComposerStateProvider } from './providers/composer-state-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveThreadStateProvider } from './providers/active-thread-provider'
import { DesktopPermissionStateProvider } from './providers/permission-provider'
import { DesktopQuestionStateProvider } from './providers/question-provider'
import { DesktopPlanStateProvider } from './providers/plan-provider'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from '@openmanager/app-core/components/fluid/ui/sidebar'
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

/** Ctrl/⌘+B toggles the sidebar, alongside Fluid's bare `[` shortcut. */
function useSidebarToggleShortcut() {
  const { toggleSidebar } = useSidebar()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])
}

function AppLayout() {
  const [convexOpen, setConvexOpen] = useState(false)
  useSidebarToggleShortcut()

  return (
    <>
      <WorkspaceSidebar
        // The window has no native titlebar: this strip drags it, and on
        // macOS it clears the traffic lights.
        titlebar={<div className="titlebar-drag h-[var(--basis-titlebar-height)] shrink-0" />}
        footer={
          <div className="flex justify-end px-1">
            <SidebarSettingsMenu
              convexOpen={convexOpen}
              onToggleConvex={() => setConvexOpen((v) => !v)}
            />
          </div>
        }
      />
      <SidebarInset className="overflow-hidden">
        <AppChrome />
        <ChatWorkspace />
      </SidebarInset>
      <ConvexTelemetryPanel open={convexOpen} onOpenChange={setConvexOpen} />
      <UpdateNotification />
    </>
  )
}

function AppShell() {
  return (
    <SidebarProvider className="h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <AppLayout />
    </SidebarProvider>
  )
}

// Providers are ordered by dependency: platform capabilities know nothing of
// sessions; session navigation needs provider startup; the composer needs
// both plus the open draft; the active thread submits turns through all three.
// See docs/application-providers.md.
function App() {
  return (
    <ThemeProvider>
      <FluidProviders>
        <CommandPalette />
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
      </FluidProviders>
    </ThemeProvider>
  )
}

export default App
