import type { EnvironmentClient } from '@openmanager/environment-client'
import { ChatWorkspace } from '../components/chat/ChatWorkspace'
import { SidebarInset, SidebarProvider } from '../components/fluid/ui/sidebar'
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
          <SidebarProvider
            persist={false}
            className="h-screen w-screen min-w-0 overflow-hidden bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]"
          >
            <WorkspaceSidebar />
            <SidebarInset className="overflow-hidden">
              <ChatWorkspace />
            </SidebarInset>
          </SidebarProvider>
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>
    </ThemeProvider>
  )
}
