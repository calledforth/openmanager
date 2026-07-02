import { useState } from 'react'
import { AppUiProvider } from './providers/app-ui-provider'
import { ThemeProvider } from './providers/theme-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveSessionProvider } from './providers/active-session-provider'
import { PermissionStateProvider } from './providers/permission-provider'
import { WorkspaceSidebar } from './components/sidebar/WorkspaceSidebar'
import { ChatView } from './components/chat/ChatView'
import { MessageInput } from './components/chat/MessageInput'
import { FloatingChatComposer } from './components/chat/FloatingChatComposer'
import { PermissionPrompt } from './components/permissions/PermissionPrompt'
import { ConvexTelemetryPanel } from './components/telemetry/ConvexTelemetryPanel'
import { ChatSectionHeader } from './components/chat/ChatSectionHeader'
import { AppChrome } from './components/shell/AppChrome'

function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [convexOpen, setConvexOpen] = useState(false)

  return (
    <div className="flex h-screen w-screen min-w-0 flex-col overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <AppChrome convexOpen={convexOpen} onToggleConvex={() => setConvexOpen((v) => !v)} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceSidebar collapsed={sidebarCollapsed} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
          <ChatSectionHeader
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          />
          <ChatView />
          <FloatingChatComposer>
            <MessageInput />
          </FloatingChatComposer>
        </div>
        <PermissionPrompt />
        <ConvexTelemetryPanel open={convexOpen} onOpenChange={setConvexOpen} />
      </div>
    </div>
  )
}

function App() {
  return (
    <ThemeProvider>
      <AppUiProvider>
        <SidebarDataProvider>
          <ActiveSessionProvider>
            <PermissionStateProvider>
              <AppShell />
            </PermissionStateProvider>
          </ActiveSessionProvider>
        </SidebarDataProvider>
      </AppUiProvider>
    </ThemeProvider>
  )
}

export default App
