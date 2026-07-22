import { useState } from 'react'
import { AppUiProvider } from './providers/app-ui-provider'
import { ThemeProvider } from './providers/theme-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveSessionProvider } from './providers/active-session-provider'
import { PermissionStateProvider } from './providers/permission-provider'
import { QuestionStateProvider } from './providers/question-provider'
import { PlanStateProvider } from './providers/plan-provider'
import { WorkspaceSidebar } from './components/sidebar/WorkspaceSidebar'
import { ChatView } from './components/chat/ChatView'
import { MessageInput } from './components/chat/MessageInput'
import { FloatingChatComposer } from './components/chat/FloatingChatComposer'
import { ConvexTelemetryPanel } from './components/telemetry/ConvexTelemetryPanel'
import { PlanPanel } from './components/plans/PlanPanel'
import { AppChrome } from './components/shell/AppChrome'
import { UpdateNotification } from './components/updates/UpdateNotification'

function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [convexOpen, setConvexOpen] = useState(false)

  return (
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <WorkspaceSidebar collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed(true)} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
        <AppChrome
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          convexOpen={convexOpen}
          onToggleConvex={() => setConvexOpen((v) => !v)}
        />
        <ChatView />
        <FloatingChatComposer>
          <MessageInput />
        </FloatingChatComposer>
      </div>
      <PlanPanel />
      <ConvexTelemetryPanel open={convexOpen} onOpenChange={setConvexOpen} />
      <UpdateNotification />
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
              <QuestionStateProvider>
                <PlanStateProvider>
                  <AppShell />
                </PlanStateProvider>
              </QuestionStateProvider>
            </PermissionStateProvider>
          </ActiveSessionProvider>
        </SidebarDataProvider>
      </AppUiProvider>
    </ThemeProvider>
  )
}

export default App
