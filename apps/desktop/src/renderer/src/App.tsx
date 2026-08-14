import { useEffect, useState } from 'react'
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
import { AppChrome } from './components/shell/AppChrome'
import { UpdateNotification } from './components/updates/UpdateNotification'
import { ensureShiki } from './lib/shiki'

// Warm the grammars at boot so the first code block arrives already
// highlighted instead of rendering plain and then repainting.
void ensureShiki().catch((error) => {
  console.error('Failed to initialize syntax highlighting', error)
})

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
  const {
    closeChildSession,
    activeWorkspacePath,
    createSession,
    openQuickLaunch,
    closeQuickLaunch,
    quickLaunchWorkspacePath,
  } = useAppUi()
  const { activeSession } = useActiveSession()
  const parentExternalId = activeSession?.parentExternalId

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape closes quick launch from anywhere, but never steals the key from
      // something that already handled it — the slash-command popup calls
      // preventDefault on its own Escape and this listener sees it afterwards.
      if (event.key === 'Escape') {
        if (event.defaultPrevented || !quickLaunchWorkspacePath) return
        event.preventDefault()
        closeQuickLaunch()
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault()
        setSidebarCollapsed((v) => !v)
        return
      }
      if (key !== 'n') return
      event.preventDefault()
      // Ctrl+N aims the composer at another project without leaving this
      // session; Ctrl+Shift+N is the plain new chat here.
      if (event.shiftKey) {
        if (activeWorkspacePath) void createSession(activeWorkspacePath)
        return
      }
      openQuickLaunch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeWorkspacePath,
    closeQuickLaunch,
    createSession,
    openQuickLaunch,
    quickLaunchWorkspacePath,
  ])

  return (
    <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
      <WorkspaceSidebar
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed(true)}
        convexOpen={convexOpen}
        onToggleConvex={() => setConvexOpen((v) => !v)}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
        <AppChrome
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />
        <ChatView />
        {/* A subagent transcript is read-only, but quick launch composes for a
            different project entirely — so it still gets a composer here. */}
        {parentExternalId && !quickLaunchWorkspacePath ? (
          <ChildSessionBanner onBack={() => closeChildSession(parentExternalId)} />
        ) : (
          <FloatingChatComposer>
            <MessageInput />
          </FloatingChatComposer>
        )}
      </div>
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
