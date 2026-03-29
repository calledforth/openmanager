import { useState } from 'react'
import { AppUiProvider } from './providers/app-ui-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveSessionProvider } from './providers/active-session-provider'
import { PermissionStateProvider } from './providers/permission-provider'
import { WorkspaceSidebar } from './components/sidebar/WorkspaceSidebar'
import { ChatView } from './components/chat/ChatView'
import { MessageInput } from './components/chat/MessageInput'
import { PermissionPrompt } from './components/permissions/PermissionPrompt'
import { ConvexTelemetryPanel } from './components/telemetry/ConvexTelemetryPanel'

function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <ChatView />
        <MessageInput />
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
