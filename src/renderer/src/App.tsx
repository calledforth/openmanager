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

function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden border-l border-[var(--basis-border-muted)] bg-[var(--basis-canvas-bg)]">
          <ChatView />
          <FloatingChatComposer>
            <MessageInput />
          </FloatingChatComposer>
        </div>
      </div>
      <PermissionPrompt />
      <ConvexTelemetryPanel />
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
