import { useEffect, useState } from 'react'
import { DesktopViewActions } from './providers/desktop-view-actions'
import { ThemeProvider } from '@openmanager/app-core/providers/theme-provider'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'
import { PlatformCapabilitiesProvider } from './providers/platform-capabilities-provider'
import { SessionStateProvider } from './providers/session-state-provider'
import { ComposerStateProvider } from './providers/composer-state-provider'
import { SidebarDataProvider } from './providers/sidebar-data-provider'
import { ActiveThreadStateProvider } from './providers/active-thread-provider'
import { PermissionStateProvider } from './providers/permission-provider'
import { QuestionStateProvider } from './providers/question-provider'
import { PlanStateProvider } from './providers/plan-provider'
import { WorkspaceSidebar } from './components/sidebar/WorkspaceSidebar'
import { ChatView } from './components/chat/ChatView'
import { MessageInput } from './components/chat/MessageInput'
import { FloatingChatComposer } from '@openmanager/app-core/components/chat/FloatingChatComposer'
import { ConvexTelemetryPanel } from './components/telemetry/ConvexTelemetryPanel'
import { AppChrome } from './components/shell/AppChrome'
import { UpdateNotification } from './components/updates/UpdateNotification'
import { ensureShiki } from '@openmanager/app-core/lib/shiki'

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
  const { closeChildSession } = useSessionState()
  const { activeThread } = useActiveThreadState()
  const parentExternalId = activeThread?.parentExternalId

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
        convexOpen={convexOpen}
        onToggleConvex={() => setConvexOpen((v) => !v)}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
        <AppChrome
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
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
                <PermissionStateProvider>
                  <QuestionStateProvider>
                    <PlanStateProvider>
                      <DesktopViewActions>
                        <AppShell />
                      </DesktopViewActions>
                    </PlanStateProvider>
                  </QuestionStateProvider>
                </PermissionStateProvider>
              </ActiveThreadStateProvider>
            </SidebarDataProvider>
          </ComposerStateProvider>
        </SessionStateProvider>
      </PlatformCapabilitiesProvider>
    </ThemeProvider>
  )
}

export default App
