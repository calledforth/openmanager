import { useState } from 'react'
import { AppUiProvider, useAppUi } from './providers/app-ui-provider'
import { ThemeProvider } from './providers/theme-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveSessionProvider, useActiveSession } from './providers/active-session-provider'
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

/** Subagent transcripts are read-only: the composer is replaced by a banner
 * linking back to the parent session. */
function ChildSessionBanner({ onBack }: { onBack: () => void }) {
  return (
    <div className="pointer-events-auto mx-auto mb-4 flex w-fit items-center gap-2 rounded-full border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-3 py-1.5 text-ui-xs text-[var(--basis-text-muted)] shadow-sm">
      <span>Subagent transcript · read-only</span>
      <button
        type="button"
        className="rounded-full border border-[var(--basis-border-muted)] px-2 py-0.5 text-[var(--basis-text)] hover:bg-[var(--basis-canvas-bg)]"
        onClick={onBack}
      >
        Back to session
      </button>
    </div>
  )
}

function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [convexOpen, setConvexOpen] = useState(false)
  const { closeChildSession } = useAppUi()
  const { activeSession } = useActiveSession()
  const parentExternalId = activeSession?.parentExternalId

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
        {parentExternalId ? (
          <ChildSessionBanner onBack={() => closeChildSession(parentExternalId)} />
        ) : (
          <FloatingChatComposer>
            <MessageInput />
          </FloatingChatComposer>
        )}
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
