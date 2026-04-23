import { useState } from 'react'
import { AppUiProvider } from './providers/app-ui-provider'
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
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-background text-foreground selection:bg-accent/25 selection:text-foreground">
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden pt-2 pr-2 pb-0 pl-0 transition-all duration-300 ease-in-out">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-xl border border-border bg-card">
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
    <AppUiProvider>
      <SidebarDataProvider>
        <ActiveSessionProvider>
          <PermissionStateProvider>
            <AppShell />
          </PermissionStateProvider>
        </ActiveSessionProvider>
      </SidebarDataProvider>
    </AppUiProvider>
  )
}

export default App
