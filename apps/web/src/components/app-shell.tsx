import { useCallback, useState, type ReactNode } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEnvironmentClientOptional } from '@openmanager/app-core/providers/environment-client'
import { EnvironmentApplicationProviders } from '@openmanager/app-core/providers/environment-application'
import { useSidebarData } from '@openmanager/app-core/providers/sidebar-provider'
import { ProjectIcon } from '@openmanager/app-core/components/sidebar/ProjectIcon'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import { useIcon } from '@openmanager/app-core/components/fluid/lib/icon-context'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@openmanager/app-core/components/fluid/ui/sidebar'
import { SidebarInsetTopbar } from '@openmanager/app-core/components/fluid/sidebar-app/inset-topbar'
import {
  SidebarWorkspaceHeader,
  WorkspaceTile,
} from '@openmanager/app-core/components/fluid/sidebar-app/workspace-header'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { useConnection } from '../providers/connection-provider'
import { AddWorkspaceDialog } from './add-workspace-dialog'
import { ConnectionBanner, ConnectionScreen, ConnectionStatusChip } from './connection-surfaces'

function isSessionPath(pathname: string) {
  return pathname === '/' || pathname.startsWith('/sessions/')
}

/** The shell's own pages as sidebar rows; Sessions only when the project list isn't there. */
function NavMenu({ pathname, includeSessions }: { pathname: string; includeSessions: boolean }) {
  const navigate = useNavigate()
  const SessionsIcon = useIcon('message-circle')
  const SettingsIcon = useIcon('settings')
  const StatesIcon = useIcon('sliders-horizontal')
  const items = [
    ...(includeSessions ? [{ to: '/', label: 'Sessions', icon: SessionsIcon }] : []),
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
    { to: '/playground/connection', label: 'States', icon: StatesIcon },
  ] as const
  return (
    <SidebarMenu aria-label="Primary">
      {items.map((item) => (
        <SidebarMenuItem key={item.to}>
          <SidebarMenuButton
            icon={item.icon}
            isActive={item.to === '/' ? isSessionPath(pathname) : pathname === item.to}
            onClick={() => void navigate({ to: item.to })}
          >
            {item.label}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

/** Project / session for the chat pane's topbar; reads the sidebar contract,
 *  so it only renders inside the environment providers. */
function SessionTrail() {
  const { workspaces, sessionsByWorkspace, activeWorkspacePath, activeSessionId } = useSidebarData()
  const project = workspaces.find((workspace) => workspace.path === activeWorkspacePath)
  const session = activeWorkspacePath
    ? sessionsByWorkspace[activeWorkspacePath]?.find((row) => row.externalId === activeSessionId)
    : undefined
  const title = (activeSessionId && session?.title) || 'New session'
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground"
      title={project ? `${project.name} / ${title}` : title}
    >
      {project ? (
        <>
          <ProjectIcon workspacePath={project.path} className="h-3.5 w-3.5 shrink-0 opacity-80" />
          <span className="min-w-0 shrink truncate">{project.name}</span>
          <span className="shrink-0 text-faint">/</span>
        </>
      ) : null}
      <span className="min-w-0 truncate text-foreground">{title}</span>
    </div>
  )
}

function ConnectedShell({
  client,
  pathname,
  children,
}: {
  client: EnvironmentClient
  pathname: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  const navigateSession = useCallback(
    (sessionId: string | null) =>
      sessionId
        ? navigate({ to: '/sessions/$sessionId', params: { sessionId } })
        : navigate({ to: '/' }),
    [navigate],
  )
  const [addingWorkspace, setAddingWorkspace] = useState(false)
  const closeAddWorkspace = useCallback(() => setAddingWorkspace(false), [])
  // The dialog owns the round trip; the sidebar only needs to know it opened.
  const addWorkspace = useCallback(async () => {
    if (!client.supports('addWorkspace')) {
      throw new Error('This environment does not support adding workspaces yet.')
    }
    setAddingWorkspace(true)
  }, [client])
  return (
    <EnvironmentApplicationProviders addWorkspace={addWorkspace} navigateSession={navigateSession}>
      {/* A healthy connection says nothing; trouble shows as the banner. */}
      <WorkspaceSidebar footer={<NavMenu pathname={pathname} includeSessions={false} />} />
      {children}
      <AddWorkspaceDialog client={client} open={addingWorkspace} onClose={closeAddWorkspace} />
    </EnvironmentApplicationProviders>
  )
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const client = useEnvironmentClientOptional()
  const {
    ui,
    connect,
    retry,
    changeEnvironment,
    selectEnvironment,
    removeEnvironment,
    environments,
    selectedId,
  } = useConnection()
  const ungated = pathname.startsWith('/playground/') || pathname === '/settings'
  const handlers = {
    onConnect: connect,
    onRetry: retry,
    onChangeEnvironment: changeEnvironment,
    onSelectEnvironment: selectEnvironment,
    onRemoveEnvironment: removeEnvironment,
  }
  const showScreen = !ungated && ui.surface === 'screen'
  const showBanner = !ungated && ui.surface === 'banner'

  const main = (
    <SidebarInset className="overflow-hidden">
      <SidebarInsetTopbar>
        {client && isSessionPath(pathname) ? <SessionTrail /> : null}
      </SidebarInsetTopbar>
      {showBanner ? <ConnectionBanner state={ui} handlers={handlers} /> : null}
      {showScreen ? (
        <ConnectionScreen
          state={ui}
          handlers={handlers}
          environments={environments}
          selectedId={selectedId}
        />
      ) : (
        <Outlet />
      )}
    </SidebarInset>
  )

  // Fluid's default sidebar: one canvas colour for the rail and the page,
  // split by a hairline.
  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden bg-background text-foreground">
      {client ? (
        <ConnectedShell client={client} pathname={pathname}>
          {main}
        </ConnectedShell>
      ) : (
        <>
          <Sidebar className="text-[15px]">
            <SidebarHeader>
              <SidebarWorkspaceHeader name="OpenManager" tile={<WorkspaceTile>O</WorkspaceTile>} />
            </SidebarHeader>
            <SidebarContent>
              <NavMenu pathname={pathname} includeSessions />
            </SidebarContent>
            <SidebarFooter>
              <ConnectionStatusChip state={ui} />
            </SidebarFooter>
          </Sidebar>
          {main}
        </>
      )}
    </SidebarProvider>
  )
}
