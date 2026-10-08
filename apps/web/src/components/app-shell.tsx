import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '@openmanager/app-core/providers/environment-client'
import { EnvironmentApplicationProviders } from '@openmanager/app-core/providers/environment-application'
import { useSidebarData } from '@openmanager/app-core/providers/sidebar-provider'
import { ProjectIcon } from '@openmanager/app-core/components/sidebar/ProjectIcon'
import { WorkspaceSidebar } from '@openmanager/app-core/components/sidebar/WorkspaceSidebar'
import { DraftDiscardNotice } from '@openmanager/app-core/components/sidebar/DraftDiscardToast'
import { phosphorIcon, useIcon } from '@openmanager/app-core/components/fluid/lib/icon-context'
import {
  CommandPalette,
  type CommandPaletteItemData,
} from '@openmanager/app-core/components/command/CommandPalette'
import { ArrowsClockwiseIcon, FolderPlusIcon, NotePencilIcon } from '@phosphor-icons/react'
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
import type { EnvironmentClient, EnvironmentState } from '@openmanager/environment-client'
import { useConnection } from '../providers/connection-provider'
import { AddWorkspaceDialog } from './add-workspace-dialog'
import { ConnectionBanner, ConnectionScreen, ConnectionStatusChip } from './connection-surfaces'
import { SessionNotifications } from './session-notifications'

const NewAgentIcon = phosphorIcon(NotePencilIcon)
const AddProjectIcon = phosphorIcon(FolderPlusIcon)
const RegenerateTitleIcon = phosphorIcon(ArrowsClockwiseIcon)

const DRAFT_PATH = '/drafts/'

function isSessionPath(pathname: string) {
  return pathname === '/' || pathname.startsWith('/sessions/') || pathname.startsWith(DRAFT_PATH)
}

/** The draft a `/drafts/<id>` address names. */
function draftIdOf(pathname: string): string | null {
  if (!pathname.startsWith(DRAFT_PATH)) return null
  const id = pathname.slice(DRAFT_PATH.length)
  if (!id || id.includes('/')) return null
  try {
    return decodeURIComponent(id)
  } catch {
    return null
  }
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
  // Fluid's menu is a bare list; the nav keeps the shell's pages a landmark.
  return (
    <nav aria-label="Primary">
      <SidebarMenu>
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
    </nav>
  )
}

const NO_COMMANDS: readonly CommandPaletteItemData[] = []

/**
 * ⌘K with the shell's own commands on top. Settings is always there; the
 * workspace commands come in once an environment is connected.
 */
function ShellCommandPalette({
  commands = NO_COMMANDS,
}: {
  commands?: readonly CommandPaletteItemData[]
}) {
  const navigate = useNavigate()
  const SettingsIcon = useIcon('settings')
  const items = useMemo<CommandPaletteItemData[]>(
    () => [
      ...commands,
      {
        value: 'go:settings',
        label: 'Open settings',
        icon: SettingsIcon,
        group: 'Go to',
        keywords: ['settings', 'preferences', 'environments', 'options'],
        onSelect: () => void navigate({ to: '/settings' }),
      },
    ],
    [commands, SettingsIcon, navigate],
  )
  return <CommandPalette commands={items} />
}

/**
 * What the connected shell lays over the page: Add project and the palette.
 * Both read the sidebar contract, so they live inside the environment
 * providers.
 */
function ConnectedOverlays({
  client,
  addingWorkspace,
  closeAddWorkspace,
}: {
  client: EnvironmentClient
  addingWorkspace: boolean
  closeAddWorkspace: () => void
}) {
  const {
    workspaces,
    activeWorkspacePath,
    activeSessionId,
    addWorkspace,
    createSession,
    regenerateSessionTitle,
  } = useSidebarData()
  // A project just added opens as a new agent in it: adding one is the
  // first step of working there.
  const openAdded = useCallback(
    (workspaceId: string) => void createSession(workspaceId),
    [createSession],
  )
  // New agent starts where the sidebar's button would: the open project,
  // else the first one still on disk.
  const newAgentTarget =
    workspaces.find((workspace) => workspace.path === activeWorkspacePath && !workspace.missing)
      ?.path ??
    workspaces.find((workspace) => !workspace.missing)?.path ??
    null
  const commands = useMemo<CommandPaletteItemData[]>(
    () => [
      ...(newAgentTarget
        ? [
            {
              value: 'action:new-agent',
              label: 'New agent',
              icon: NewAgentIcon,
              group: 'Actions',
              keywords: ['new', 'agent', 'session', 'chat', 'thread', 'start'],
              onSelect: () => void createSession(newAgentTarget),
            },
          ]
        : []),
      {
        value: 'action:add-project',
        label: 'Add project',
        icon: AddProjectIcon,
        group: 'Actions',
        keywords: ['add', 'project', 'workspace', 'folder', 'open'],
        onSelect: () => void addWorkspace(),
      },
      // Only for the session on screen, and only where the environment
      // can write titles; the new name arrives like any other rename.
      ...(activeSessionId && regenerateSessionTitle
        ? [
            {
              value: 'action:regenerate-title',
              label: 'Regenerate title',
              icon: RegenerateTitleIcon,
              group: 'Actions',
              keywords: ['regenerate', 'rename', 'title', 'name', 'session'],
              onSelect: () => void regenerateSessionTitle(activeSessionId),
            },
          ]
        : []),
    ],
    [newAgentTarget, createSession, addWorkspace, activeSessionId, regenerateSessionTitle],
  )
  return (
    <>
      <ShellCommandPalette commands={commands} />
      <AddWorkspaceDialog
        client={client}
        open={addingWorkspace}
        onClose={closeAddWorkspace}
        onAdded={openAdded}
      />
    </>
  )
}

const selectActiveTitle = (state: EnvironmentState) =>
  state.activeSessionId ? (state.sessions[state.activeSessionId]?.title ?? null) : null

/** Project / session for the chat pane's topbar; reads the sidebar contract,
 *  so it only renders inside the environment providers. The title is read on
 *  its own: the session list changes far more often than the open session's
 *  name, and the topbar has no business rendering for the rest. */
function SessionTrail() {
  const { workspaces, activeWorkspacePath, activeSessionId } = useSidebarData()
  const sessionTitle = useEnvironmentState(selectActiveTitle)
  const project = workspaces.find((workspace) => workspace.path === activeWorkspacePath)
  const title = (activeSessionId && sessionTitle) || 'New session'
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
    (sessionId: string | null, options?: { replace?: boolean }) =>
      sessionId
        ? navigate({ to: '/sessions/$sessionId', params: { sessionId }, replace: options?.replace })
        : navigate({ to: '/', replace: options?.replace }),
    [navigate],
  )
  const navigateDraft = useCallback(
    (draftId: string, options?: { replace?: boolean }) =>
      navigate({ to: '/drafts/$draftId', params: { draftId }, replace: options?.replace }),
    [navigate],
  )
  const landingDraftId = draftIdOf(pathname)
  const openSession = useCallback(
    (sessionId: string) => void navigateSession(sessionId),
    [navigateSession],
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
    <EnvironmentApplicationProviders
      addWorkspace={addWorkspace}
      navigateSession={navigateSession}
      navigateDraft={navigateDraft}
      // `/` is a blank new-session page, ready on arrival; `/drafts/<id>` is
      // a draft's own page, which it gets with its first text or image.
      onLanding={pathname === '/' || landingDraftId !== null}
      landingDraftId={landingDraftId}
    >
      {/* A healthy connection says nothing; trouble shows as the banner. */}
      <WorkspaceSidebar footer={<NavMenu pathname={pathname} includeSessions={false} />} />
      {children}
      <ConnectedOverlays
        client={client}
        addingWorkspace={addingWorkspace}
        closeAddWorkspace={closeAddWorkspace}
      />
      <SessionNotifications openSession={openSession} />
      {/* Beside the sidebar, not in it: on a phone the sidebar is a modal
          sheet that closes on the tap that reaches for Undo. */}
      <DraftDiscardNotice />
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
    confirmRoute,
    declineRoute,
    selectEnvironment,
    removeEnvironment,
    chooseRoute,
    removeRoute,
    checkRoutes,
    environments,
    selectedId,
    inUseEndpoint,
  } = useConnection()
  // Pairing is how a browser with no environment gets one, so it never waits
  // behind the connect screen.
  const ungated =
    pathname.startsWith('/playground/') || pathname === '/settings' || pathname === '/pair'
  const handlers = {
    onConnect: connect,
    onRetry: retry,
    onChangeEnvironment: changeEnvironment,
    onConfirmRoute: confirmRoute,
    onDeclineRoute: declineRoute,
    onSelectEnvironment: selectEnvironment,
    onRemoveEnvironment: removeEnvironment,
    onChooseRoute: chooseRoute,
    onRemoveRoute: removeRoute,
    onCheckRoutes: checkRoutes,
  }
  const showScreen = !ungated && ui.surface === 'screen'
  const showBanner = !ungated && ui.surface === 'banner'

  const main = (
    <SidebarInset className="overflow-hidden">
      <SidebarInsetTopbar>
        {client && isSessionPath(pathname) ? <SessionTrail /> : null}
      </SidebarInsetTopbar>
      {/* Floats over the page under the topbar, so the session stays where it was. */}
      {showBanner ? (
        <div className="pointer-events-none absolute inset-x-0 top-11 z-30 flex justify-center px-3">
          <ConnectionBanner className="pointer-events-auto" state={ui} handlers={handlers} />
        </div>
      ) : null}
      {showScreen ? (
        <ConnectionScreen
          state={ui}
          handlers={handlers}
          environments={environments}
          selectedId={selectedId}
          inUseEndpoint={inUseEndpoint}
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
          <ShellCommandPalette />
        </>
      )}
    </SidebarProvider>
  )
}
