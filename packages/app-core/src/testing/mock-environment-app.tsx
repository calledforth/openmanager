import type { EnvironmentClient } from '@openmanager/environment-client'
import { ChatWorkspace } from '../components/chat/ChatWorkspace'
import { WorkspaceSidebar } from '../components/sidebar/WorkspaceSidebar'
import { EnvironmentApplicationProviders } from '../providers/environment-application'
import { EnvironmentClientProvider } from '../providers/environment-client'
import { ThemeProvider } from '../providers/theme-provider'

/**
 * Sidebar + chat + composer over a supplied environment client. Used by
 * Storybook and the CAL-43 vitest suite so both exercise the same core UI
 * without Convex or a live server.
 */
export function MockEnvironmentApp({
  client,
  addWorkspace,
}: {
  client: EnvironmentClient
  addWorkspace?: () => Promise<void>
}) {
  return (
    <ThemeProvider>
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders
          addWorkspace={addWorkspace}
          collapsedWorkspaceStorage={null}
        >
          <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
            <WorkspaceSidebar collapsed={false} />
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--basis-canvas-bg)]">
              <ChatWorkspace />
            </div>
          </div>
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>
    </ThemeProvider>
  )
}
