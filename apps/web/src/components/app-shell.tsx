import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  EnvironmentClientProvider,
  useEnvironmentClientOptional,
} from '@openmanager/app-core/providers/environment-client'
import { EnvironmentApplicationProviders } from '@openmanager/app-core/providers/environment-application'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import {
  EnvironmentAvailabilityContext,
  type EnvironmentAvailability,
} from '@openmanager/app-core/providers/environment-availability'
import { useSidebarData } from '@openmanager/app-core/providers/sidebar-provider'
import { SessionTrail } from '@openmanager/app-core/components/chat/SessionTrail'
import { phosphorIcon, useIcon } from '@openmanager/app-core/components/fluid/lib/icon-context'
import {
  CommandPalette,
  type CommandPaletteItemData,
} from '@openmanager/app-core/components/command/CommandPalette'
import {
  requestSearch,
  SEARCH_SHORTCUT,
} from '@openmanager/app-core/components/command/SearchPalette'
import {
  QUICK_AGENT_SHORTCUT,
  QuickAgentPalette,
  requestQuickAgent,
  useQuickAgentAvailable,
} from '@openmanager/app-core/components/command/QuickAgentPalette'
import {
  ArrowsClockwiseIcon,
  FolderPlusIcon,
  GaugeIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
} from '@phosphor-icons/react'
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
  useSidebar,
} from '@openmanager/app-core/components/fluid/ui/sidebar'
import { SidebarInsetTopbar } from '@openmanager/app-core/components/fluid/sidebar-app/inset-topbar'
import {
  SidePanelHost,
  SidePanelPillSlot,
} from '@openmanager/app-core/components/side-panel/SidePanel'
import {
  SidebarWorkspaceHeader,
  WorkspaceTile,
} from '@openmanager/app-core/components/fluid/sidebar-app/workspace-header'
import type { EnvironmentClient } from '@openmanager/environment-client'
import {
  otherEnvironmentsNotice,
  placeConnectionUi,
  sendBlockedReason,
} from '@openmanager/environment-client/connection'
import { isBrowserOnline, subscribeToNetworkStatus } from '../lib/browser-runtime'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'
import { addressOf, AddressLookupProvider, useFindAddress } from '../providers/address-environment'
import { AddWorkspaceDialog } from './add-workspace-dialog'
import { QuickAgentWebHost } from './quick-agent-host'
import {
  ConnectionBanner,
  ConnectionScreen,
  ConnectionStatusChip,
  OtherEnvironmentsStatus,
} from './connection-surfaces'
import {
  EnvironmentFailureNotice,
  EnvironmentsSidebarHost,
  SidebarSource,
} from './environments-sidebar'
import { EnvironmentNotifications } from './session-notifications'
import { SidebarDock } from './sidebar-dock'
import { ServerTooOldCallout, ServerUpdateToasts } from './server-update'
import { ServerUpdatesProvider } from '../providers/server-updates'
import { SessionSidePanel } from './session-side-panel'

const NewAgentIcon = phosphorIcon(NotePencilIcon)
const AddProjectIcon = phosphorIcon(FolderPlusIcon)
const UsageIcon = phosphorIcon(GaugeIcon)
const RegenerateTitleIcon = phosphorIcon(ArrowsClockwiseIcon)
const SearchIcon = phosphorIcon(MagnifyingGlassIcon)

function isSessionPath(pathname: string) {
  return pathname === '/' || pathname.startsWith('/sessions/') || pathname.startsWith('/drafts/')
}

/** The shell's own pages as sidebar rows; Sessions only when the project list isn't there. */
function NavMenu({ pathname, includeSessions }: { pathname: string; includeSessions: boolean }) {
  const navigate = useNavigate()
  // On a phone the rows sit in a sheet over the page; going to one closes it.
  const { isMobile, setOpenMobile } = useSidebar()
  const SessionsIcon = useIcon('message-circle')
  const SettingsIcon = useIcon('settings')
  // The connection-states playground is a dev page: ⌘K and its URL reach it.
  const items = [
    ...(includeSessions ? [{ to: '/', label: 'Sessions', icon: SessionsIcon }] : []),
    { to: '/usage', label: 'Usage', icon: UsageIcon },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
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
              onClick={() => {
                if (isMobile) setOpenMobile(false)
                void navigate({ to: item.to })
              }}
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

const onlineOnServer = () => true

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
  const StatesIcon = useIcon('sliders-horizontal')
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
      {
        value: 'go:usage',
        label: 'Open usage',
        icon: UsageIcon,
        group: 'Go to',
        keywords: ['usage', 'limits', 'quota', 'plan', 'claude'],
        onSelect: () => void navigate({ to: '/usage' }),
      },
      {
        value: 'go:states',
        label: 'Open connection states',
        icon: StatesIcon,
        group: 'Go to',
        keywords: ['states', 'playground', 'connection', 'debug'],
        onSelect: () => void navigate({ to: '/playground/connection' }),
      },
    ],
    [commands, SettingsIcon, StatesIcon, navigate],
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
  environmentId,
  addingWorkspace,
  closeAddWorkspace,
}: {
  client: EnvironmentClient
  environmentId: string | null
  addingWorkspace: boolean
  closeAddWorkspace: () => void
}) {
  const {
    workspaces,
    activeWorkspacePath,
    activeEnvironmentId,
    activeSessionId,
    addWorkspace,
    createSession,
    regenerateSessionTitle,
  } = useSidebarData()
  // Settings can be acting on another environment behind the palette, so with
  // several saved, Add project says whose list it adds to.
  const { environments } = useConnection()
  const addsTo =
    environments.length > 1
      ? environments.find((item) => item.environmentId === activeEnvironmentId)?.label
      : undefined
  const { isDraftProjectRemoved, setDraftWorkspace } = useSessionState()
  // A project just added opens as a new agent in it: adding one is the
  // first step of working there. A draft waiting for a project takes it.
  const openAdded = useCallback(
    (workspaceId: string) => {
      if (isDraftProjectRemoved && setDraftWorkspace) setDraftWorkspace(workspaceId)
      else void createSession(workspaceId)
    },
    [createSession, isDraftProjectRemoved, setDraftWorkspace],
  )
  // New agent opens the quick palette over the page; where there is none
  // (an environment that keeps no drafts) it opens a page where the
  // sidebar's button would: the open project, else the first one on disk.
  const quickAgent = useQuickAgentAvailable()
  const newAgentTarget =
    workspaces.find((workspace) => workspace.path === activeWorkspacePath && !workspace.missing)
      ?.path ??
    workspaces.find((workspace) => !workspace.missing && !workspace.scratch)?.path ??
    workspaces.find((workspace) => !workspace.missing)?.path ??
    null
  const commands = useMemo<CommandPaletteItemData[]>(
    () => [
      ...(quickAgent
        ? [
            {
              value: 'action:new-agent',
              label: 'New agent…',
              icon: NewAgentIcon,
              group: 'Actions',
              shortcut: QUICK_AGENT_SHORTCUT,
              keywords: ['new', 'agent', 'session', 'chat', 'thread', 'start', 'create'],
              onSelect: () => void requestQuickAgent(),
            },
          ]
        : newAgentTarget
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
        value: 'action:search',
        label: 'Search sessions and messages…',
        icon: SearchIcon,
        group: 'Actions',
        shortcut: SEARCH_SHORTCUT,
        keywords: ['search', 'find', 'messages', 'sessions', 'chats', 'history'],
        onSelect: () => requestSearch(),
      },
      {
        value: 'action:add-project',
        label: addsTo ? `Add project to ${addsTo}` : 'Add project',
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
    [
      quickAgent,
      newAgentTarget,
      createSession,
      addWorkspace,
      addsTo,
      activeSessionId,
      regenerateSessionTitle,
    ],
  )
  return (
    <>
      <ShellCommandPalette commands={commands} />
      <QuickAgentPalette {...(environmentId ? { environmentId } : {})} />
      <AddWorkspaceDialog
        client={client}
        open={addingWorkspace}
        onClose={closeAddWorkspace}
        onAdded={openAdded}
      />
    </>
  )
}

function ConnectedShell({
  client,
  environmentId,
  availability,
  pathname,
  landingDraftId,
  holdLandingDraft,
  children,
}: {
  client: EnvironmentClient
  environmentId: string | null
  availability: EnvironmentAvailability
  pathname: string
  landingDraftId: string | null
  holdLandingDraft: boolean
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
    <EnvironmentAvailabilityContext.Provider value={availability}>
      <EnvironmentApplicationProviders
        {...(environmentId ? { environmentId } : {})}
        addWorkspace={addWorkspace}
        navigateSession={navigateSession}
        navigateDraft={navigateDraft}
        // `/` is a blank new-session page, ready on arrival; `/drafts/<id>` is
        // a draft's own page, which it gets with its first text or image.
        onLanding={pathname === '/' || landingDraftId !== null}
        landingDraftId={landingDraftId}
        holdLandingDraft={holdLandingDraft}
      >
        <SidebarSource />
        {children}
        <ConnectedOverlays
          client={client}
          environmentId={environmentId}
          addingWorkspace={addingWorkspace}
          closeAddWorkspace={closeAddWorkspace}
        />
      </EnvironmentApplicationProviders>
    </EnvironmentAvailabilityContext.Provider>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const selectedClient = useEnvironmentClientOptional()
  const { clients } = useEnvironmentClients()
  const address = useMemo(() => addressOf(pathname), [pathname])
  const lookup = useFindAddress(address)
  // The owner only counts with its client in hand: the shell is keyed by, and
  // names, the environment whose client it is given.
  const ownerClient = lookup.owner ? clients[lookup.owner] : undefined
  const client = ownerClient || selectedClient
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
    links,
  } = useConnection()
  const shellEnvironmentId = (ownerClient && lookup.owner) || selectedId
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
  // Whose page this is, and how the others are doing.
  const openId = shellEnvironmentId
  const labelOf = (environmentId: string | null) =>
    environments.find((item) => item.environmentId === environmentId)?.label
  const openLabel = labelOf(openId) ?? 'this environment'
  const openState = links.find((link) => link.environmentId === openId)?.ui
  const blocked = openState ? sendBlockedReason(openState, openLabel) : null
  const several = environments.length > 1
  // With one saved the composer reads as it always has: the banner says it all.
  const availability = useMemo<EnvironmentAvailability>(
    () => (several ? { name: openLabel, sendBlockedReason: blocked } : { sendBlockedReason: null }),
    [blocked, openLabel, several],
  )
  // With no network every environment is out of reach, and the banner already
  // says "You're offline": naming each of them again adds nothing.
  const online = useSyncExternalStore(subscribeToNetworkStatus, isBrowserOnline, onlineOnServer)
  const othersNotice =
    ungated || !online
      ? null
      : otherEnvironmentsNotice(
          links
            .filter((link) => link.environmentId !== openId)
            .map((link) => ({
              label: labelOf(link.environmentId) ?? link.environmentId,
              state: link.ui,
            })),
        )

  const placed = placeConnectionUi(ui, environments.length)
  const showScreen = !ungated && placed.surface === 'screen'
  const showBanner = !ungated && placed.surface === 'banner'

  const sessionView = Boolean(client) && isSessionPath(pathname) && !showScreen
  // The host stays mounted on every page, so moving between pages never
  // remounts the page under it; only session pages declare a side panel.
  const main = (
    <SidebarInset className="overflow-hidden">
      <SidePanelHost>
        <SidebarInsetTopbar
          end={
            <>
              {othersNotice ? (
                <OtherEnvironmentsStatus
                  notice={othersNotice}
                  onOpenSettings={() => void navigate({ to: '/settings' })}
                />
              ) : null}
              <SidePanelPillSlot />
            </>
          }
        >
          {client && isSessionPath(pathname) ? <SessionTrail /> : null}
        </SidebarInsetTopbar>
        {/* Floats over the page under the topbar, so the session stays where it was. */}
        <div className="pointer-events-none absolute inset-x-0 top-11 z-30 flex flex-col items-center gap-1.5 px-3">
          {showBanner ? (
            <ConnectionBanner className="pointer-events-auto" state={placed} handlers={handlers} />
          ) : null}
          <EnvironmentFailureNotice className="pointer-events-auto" />
          <ServerUpdateToasts className="pointer-events-auto" />
        </div>
        {showScreen ? (
          <ConnectionScreen
            state={ui}
            handlers={handlers}
            environments={environments}
            selectedId={selectedId}
            inUseEndpoint={inUseEndpoint}
            extra={
              ui.kind === 'incompatible_protocol' &&
              ui.serverProtocolVersion !== undefined &&
              ui.clientProtocolVersion !== undefined &&
              ui.serverProtocolVersion < ui.clientProtocolVersion ? (
                <ServerTooOldCallout environmentId={selectedId} />
              ) : null
            }
          />
        ) : (
          <Outlet />
        )}
        {sessionView ? <SessionSidePanel /> : null}
      </SidePanelHost>
    </SidebarInset>
  )

  // Fluid's default sidebar: one canvas colour for the rail and the page,
  // split by a hairline.
  return (
    <ServerUpdatesProvider>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <EnvironmentClientProvider client={client}>
          <AddressLookupProvider value={lookup}>
            <EnvironmentNotifications openId={lookup.owner ?? selectedId} />
            {/* Above the choice of what is open: an environment with no client
              takes neither the sidebar nor the other environments' cards with it. */}
            <EnvironmentsSidebarHost
              footer={<SidebarDock pathname={pathname} />}
              fallback={
                <Sidebar className="text-[15px]">
                  <SidebarHeader>
                    <SidebarWorkspaceHeader
                      name="OpenManager"
                      tile={<WorkspaceTile>O</WorkspaceTile>}
                    />
                  </SidebarHeader>
                  <SidebarContent>
                    <NavMenu pathname={pathname} includeSessions />
                  </SidebarContent>
                  <SidebarFooter>
                    <ConnectionStatusChip state={ui} />
                  </SidebarFooter>
                </Sidebar>
              }
            >
              {/* Above the shell keyed by environment: the New agent card's draft
                outlives the page's environment and can move to another. */}
              <QuickAgentWebHost shellEnvironmentId={client ? shellEnvironmentId : null}>
                {client ? (
                  // By environment, not by client: its drafts and page state are that
                  // environment's, while a client replaced on the same environment keeps
                  // the page as it is.
                  <ConnectedShell
                    key={shellEnvironmentId}
                    client={client}
                    environmentId={shellEnvironmentId}
                    availability={availability}
                    pathname={pathname}
                    landingDraftId={address?.kind === 'draft' ? address.id : null}
                    holdLandingDraft={address?.kind === 'draft' && lookup.status === 'searching'}
                  >
                    {main}
                  </ConnectedShell>
                ) : (
                  <>
                    {main}
                    <ShellCommandPalette />
                  </>
                )}
              </QuickAgentWebHost>
            </EnvironmentsSidebarHost>
          </AddressLookupProvider>
        </EnvironmentClientProvider>
      </SidebarProvider>
    </ServerUpdatesProvider>
  )
}
