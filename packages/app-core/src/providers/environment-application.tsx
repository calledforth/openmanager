import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  isProviderId,
  type PlanReviewOutcome,
  type ProviderId,
  type ProviderMetadata,
  type PromptCapabilities,
  type QuestionOutcome,
  type PermissionOption,
} from '@agentpack/contract'
import {
  PROVIDER_HEALTH_STALE_MS,
  deriveProviderUiStatus,
  type ProviderHealthReport,
} from '@openmanager/shared/contracts/provider-health'
import type { InteractionResponse, Workspace } from '@openmanager/protocol'
import {
  UPLOAD_TICKET_COMMAND,
  selectActiveSession,
  selectActiveThread,
  selectProviderCatalog,
  shallowEqualArray,
  type EnvironmentState,
  type PendingInteraction,
  type ProviderCatalogEntry,
  type ThreadTarget,
} from '@openmanager/environment-client'
import {
  sameUploadScope,
  type DraftImageAttachment,
  type UploadedImageAttachment,
  type UploadScope,
} from '../lib/attachments'
import {
  useActiveSession,
  useActiveThread,
  useActiveTurn,
  useConnectionState,
  useEnvironmentClient,
  useEnvironmentState,
  usePendingInteractions,
  useSessionList,
  useRecentWorkspaces,
  useWorkspaces,
} from './environment-client'
import {
  PlatformCapabilitiesContext,
  coordinateProviderConnection,
  providerBlocksComposer,
  type AgentInfo,
  type PlatformCapabilitiesValue,
  type ProviderUiStatus,
} from './platform-provider'
import {
  SessionStateContext,
  type DraftRequest,
  type LaunchingMessage,
  type LocalSessionStatus,
  type SessionStateValue,
} from './session-provider'
import {
  DraftLaunchContext,
  EnvironmentComposerStateProvider,
  type DraftLaunch,
} from './environment-composer'
import { EnvironmentComposerDraftProvider } from './environment-drafts'
import {
  SidebarDataContext,
  SidebarSessionsContext,
  toggleCollapsedWorkspace,
  type SidebarDataValue,
  type SidebarEnvironment,
  type SidebarSessionEntry,
  type SidebarSessionsByWorkspace,
  type WorkspaceEntry,
} from './sidebar-provider'
import {
  ActiveThreadStateContext,
  ActiveThreadStoresContext,
  type ActiveThreadDetails,
  type ActiveThreadStateValue,
  type ActiveThreadStores,
  type UIMessage,
} from './active-thread-provider'
import {
  PermissionStateProvider,
  type PendingPermission,
  type PermissionSelection,
} from './permission-provider'
import { QuestionStateProvider, type PendingQuestion } from './question-provider'
import { PlanStateProvider, type PlanRow } from './plan-provider'
import { ViewActionsContext, type ViewActions } from './view-actions'
import { createEnvironmentThreadStores } from '../lib/environment-thread'
import { providerHealthReportFromWire } from '../lib/provider-health-view'

const DEFAULT_PROVIDER_ID: ProviderId = 'opencode'
const COLLAPSED_WORKSPACES_KEY = 'openmanager.sidebar.collapsed-workspaces'

/** Stable identity: an inline callback here re-renders every message row. */
const noop = () => undefined
const EMPTY_LIST: never[] = []

export interface EnvironmentApplicationOptions {
  /** How this host lets the user add a workspace; absent means it cannot. */
  addWorkspace?: () => Promise<void>
  /** Routed hosts navigate first; the destination owns session hydration. */
  navigateSession?: (sessionId: string | null) => Promise<void>
  /** True while the host shows its new-session landing (on the web, the `/`
   * route). With no session and no draft open there, a draft stands in the
   * most recently used project, so the composer is ready on arrival. Left
   * false, a draft opens only when asked for. */
  onLanding?: boolean
  /** Where folded sidebar rows are remembered. Defaults to `localStorage`. */
  collapsedWorkspaceStorage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Host actions for views (child sessions, icons, uploads). */
  viewActions?: Omit<ViewActions, 'activeSessionId'>
}

/**
 * Implements every application provider contract over the environment
 * client, so the shared sidebar, chat, composer and interaction panels render
 * against an environment server (or the mock) with no host-specific
 * providers at all. Composer state lives in `environment-composer.tsx`.
 */
export function EnvironmentApplicationProviders({
  children,
  ...options
}: EnvironmentApplicationOptions & { children: ReactNode }) {
  return (
    <EnvironmentPlatformCapabilitiesProvider>
      <EnvironmentSessionStateProvider
        addWorkspace={options.addWorkspace}
        navigateSession={options.navigateSession}
        onLanding={options.onLanding ?? false}
      >
        <EnvironmentComposerStateProvider>
          <EnvironmentComposerDraftProvider>
            <EnvironmentSidebarDataProvider storage={options.collapsedWorkspaceStorage}>
              <EnvironmentActiveThreadProvider>
                <EnvironmentInteractionProviders>
                  <EnvironmentViewActions actions={options.viewActions}>
                    {children}
                  </EnvironmentViewActions>
                </EnvironmentInteractionProviders>
              </EnvironmentActiveThreadProvider>
            </EnvironmentSidebarDataProvider>
          </EnvironmentComposerDraftProvider>
        </EnvironmentComposerStateProvider>
      </EnvironmentSessionStateProvider>
    </EnvironmentPlatformCapabilitiesProvider>
  )
}

// ---------------------------------------------------------------------------
// Platform capabilities: the environment owns providers; this reads its
// discovery and health, and probes through it.
// ---------------------------------------------------------------------------

const statusOf = (entry: Pick<ProviderCatalogEntry, 'health'>): ProviderUiStatus =>
  deriveProviderUiStatus(providerHealthReportFromWire(entry.health))

function EnvironmentPlatformCapabilitiesProvider({ children }: { children: ReactNode }) {
  const client = useEnvironmentClient()
  const environment = useEnvironmentState((state) => state.environment)
  const catalog = useEnvironmentState(selectProviderCatalog, shallowEqualArray)
  // Advertised capabilities arrive with the handshake, so this re-reads them
  // on connect rather than latching the pre-handshake "unsupported".
  const canProbe = useConnectionState().capabilities.includes('provider.probe')
  /** Probes in flight per provider: one per workspace can run at once. */
  const [probing, setProbing] = useState<Partial<Record<ProviderId, number>>>({})
  const [error, setError] = useState<string | null>(null)
  // A probe runs in one workspace and can answer differently in another, so
  // only callers asking about the same provider in the same workspace share one.
  const probesRef = useRef<Map<string, Promise<boolean>>>(new Map())

  // A reading ages out with no event to say so: a provider with nothing
  // running reads ready until its last probe is too old to trust. One timer
  // at the earliest such deadline re-derives then, rather than a ticking clock
  // that would re-render every consumer on an interval.
  const [staleTick, setStaleTick] = useState(0)
  useEffect(() => {
    const now = Date.now()
    let deadline = Infinity
    for (const entry of catalog) {
      const at = entry.health.lastProbe ? Date.parse(entry.health.lastProbe.at) : NaN
      if (entry.health.runtime.liveProcesses > 0 || Number.isNaN(at)) continue
      const expires = at + PROVIDER_HEALTH_STALE_MS
      if (expires >= now) deadline = Math.min(deadline, expires)
    }
    if (deadline === Infinity) return
    // Staleness is strictly "older than", so land just past the deadline.
    const timer = setTimeout(() => setStaleTick((tick) => tick + 1), deadline - now + 1)
    return () => clearTimeout(timer)
  }, [catalog, staleTick])

  const derived = useMemo(() => {
    const now = Date.now()
    const providers: ProviderMetadata[] = []
    const providerHealthByProvider: Partial<Record<ProviderId, ProviderHealthReport>> = {}
    const agentUiStatusByProvider: Partial<Record<ProviderId, ProviderUiStatus>> = {}
    const acpAgentInfoByProvider: Partial<Record<ProviderId, AgentInfo>> = {}
    const acpPromptCapabilitiesByProvider: Partial<Record<ProviderId, PromptCapabilities>> = {}
    for (const entry of catalog) {
      // The shared views key icons and copy by the providers they know.
      if (!isProviderId(entry.id)) continue
      providers.push({
        id: entry.id,
        displayName: entry.displayName,
        capabilities: entry.capabilities,
      })
      const report = providerHealthReportFromWire(entry.health)
      providerHealthByProvider[entry.id] = report
      const status = deriveProviderUiStatus(report, now)
      // Same bridge as desktop: a probe this client started reads as checking
      // until the environment's own `refreshing` push takes over.
      agentUiStatusByProvider[entry.id] =
        status === 'unknown' && probing[entry.id] ? 'probing' : status
      if (entry.profile?.agentInfo) acpAgentInfoByProvider[entry.id] = entry.profile.agentInfo
      // Same source desktop reads off `initialized`: the environment records
      // the handshake's answer on the profile, so the composer's image gate
      // has it before any session and keeps it across reconnects.
      if (entry.profile?.promptCapabilities) {
        acpPromptCapabilitiesByProvider[entry.id] = entry.profile.promptCapabilities
      }
    }
    return {
      providers,
      providerHealthByProvider,
      agentUiStatusByProvider,
      acpAgentInfoByProvider,
      acpPromptCapabilitiesByProvider,
    }
    // `staleTick` is read for its timing only: it re-runs this at a deadline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, probing, staleTick])

  const providerDisplayName = useCallback(
    (providerId: ProviderId) =>
      derived.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId,
    [derived.providers],
  )

  /** Probe now and answer whether the provider can take a prompt. */
  const probe = useCallback(
    (providerId: ProviderId, workspaceId: string) =>
      coordinateProviderConnection(
        probesRef.current,
        JSON.stringify([providerId, workspaceId]),
        async () => {
          setProbing((prev) => ({ ...prev, [providerId]: (prev[providerId] ?? 0) + 1 }))
          try {
            const provider = await client.commands.probeProvider({ providerId, workspaceId })
            return !providerBlocksComposer(statusOf(provider))
          } catch {
            return false
          } finally {
            setProbing((prev) => ({ ...prev, [providerId]: (prev[providerId] ?? 1) - 1 }))
          }
        },
      ),
    [client],
  )

  const ensureProvider = useCallback(
    async (providerId: ProviderId, cwd: string) => {
      const entry = client.getState().providers[providerId]
      // An environment that lists no providers gates sends on its own.
      if (!entry) return true
      const status = statusOf(entry)
      // A probe spawns the CLI, so a provider already known to work is not
      // re-checked before every new chat.
      if (status === 'ready' || status === 'degraded') return true
      if (!canProbe || !cwd) return !providerBlocksComposer(status)
      return probe(providerId, cwd)
    },
    [canProbe, client, probe],
  )

  const retryProvider = useCallback(
    async (providerId: ProviderId, cwd = '') => {
      setError(null)
      // A probe runs in a registered workspace; any one will do for a retry.
      const workspaceId = cwd || client.getState().workspaceOrder[0]
      if (!canProbe || !workspaceId) {
        setError(
          canProbe
            ? 'Add a workspace to check providers.'
            : 'This environment cannot re-check providers.',
        )
        return
      }
      const ready = await probe(providerId, workspaceId)
      if (!ready) setError(`Failed to connect to ${providerDisplayName(providerId)}.`)
    },
    [canProbe, client, probe, providerDisplayName],
  )

  const value = useMemo<PlatformCapabilitiesValue>(
    () => ({
      ...derived,
      currentClientId: environment?.environmentId ?? null,
      error,
      ensureProvider,
      retryProvider,
      providerDisplayName,
    }),
    [
      derived,
      environment?.environmentId,
      ensureProvider,
      error,
      providerDisplayName,
      retryProvider,
    ],
  )
  return (
    <PlatformCapabilitiesContext.Provider value={value}>
      {children}
    </PlatformCapabilitiesContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Session state: navigation through the client, drafts kept locally.
// ---------------------------------------------------------------------------

interface DraftInternals {
  /** Create the draft's session with what the composer picked, open it and
   * adopt it; returns its first thread, or `null` when the draft was closed or
   * replaced meanwhile. */
  startDraftSession: (
    text: string,
    launch: DraftLaunch,
    artifactIds?: string[],
  ) => Promise<ThreadTarget | null>
}

const DraftInternalsContext = createContext<DraftInternals | null>(null)

/** A project a session can be started in right now. */
function canHostDraft(workspace: Workspace | undefined): workspace is Workspace {
  if (!workspace) return false
  return workspace.availability ? workspace.availability === 'available' : workspace.exists
}

/** Where a landing draft opens: the project most recently worked in, else
 * the first one listed that is there to work in. */
function landingWorkspaceFor(workspaces: Workspace[], recent: Workspace[]): string | null {
  return (recent.find(canHostDraft) ?? workspaces.find(canHostDraft))?.workspaceId ?? null
}

const selectActiveSessionId = (state: EnvironmentState) =>
  selectActiveSession(state)?.sessionId ?? null
const selectActiveSessionWorkspaceId = (state: EnvironmentState) =>
  selectActiveSession(state)?.workspaceId ?? null
const selectActiveThreadId = (state: EnvironmentState) =>
  selectActiveThread(state)?.thread.threadId ?? null

function EnvironmentSessionStateProvider({
  addWorkspace,
  navigateSession,
  onLanding,
  children,
}: {
  addWorkspace?: () => Promise<void>
  navigateSession?: (sessionId: string | null) => Promise<void>
  onLanding: boolean
  children: ReactNode
}) {
  const client = useEnvironmentClient()
  const { commands } = client
  // Only which session is on screen, and where: its title, status or settle
  // are the sidebar's and the thread's to show, and reading the whole session
  // here would hand every reader of session state a new value on each.
  const activeSessionId = useEnvironmentState(selectActiveSessionId)
  const activeSessionWorkspaceId = useEnvironmentState(selectActiveSessionWorkspaceId)
  const activeTurn = useActiveTurn()
  const workspaces = useWorkspaces()
  const recentWorkspaces = useRecentWorkspaces()
  // A draft the user opened. The landing's own draft is derived below.
  const [openedDraftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null)
  // The landing's draft, once it has been shown. Held so that activity in
  // another project, which reorders the recent list, does not move a draft
  // the user may already be typing into.
  const [heldLandingWorkspaceId, setHeldLandingWorkspaceId] = useState<string | null>(null)
  const [pendingDraftSessionStart, setPendingDraftSessionStart] = useState(false)
  const [launchingMessage, setLaunchingMessage] = useState<LaunchingMessage | null>(null)
  const [turnPending, setTurnPending] = useState(false)
  const [adoptedDraftSessionId, setAdoptedDraftSessionId] = useState<string | null>(null)
  const [defaultProviderId, setDefaultProviderIdState] = useState<ProviderId>(DEFAULT_PROVIDER_ID)
  const [draftRequest, setDraftRequest] = useState<DraftRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Bumped whenever the draft is opened, closed or replaced, so a session
  // creation still in flight can tell that its draft no longer stands.
  const draftGenerationRef = useRef(0)
  // The session the user most recently asked for (null once a draft is
  // opened). Session opens resolve in any order; a slow one for an earlier
  // choice must not leave its session active after a later choice landed.
  const selectionRef = useRef<string | null>(null)

  // The session the client has selected, whether or not its row has arrived.
  const selectedSessionId = useEnvironmentState((state) => state.activeSessionId)

  // Without this the landing names a project while nothing is open in it, and
  // the composer below stays locked until another project is picked.
  const landingOpen = onLanding && selectedSessionId === null && openedDraftWorkspaceId === null
  const heldLandingWorkspace = workspaces.find(
    (workspace) => workspace.workspaceId === heldLandingWorkspaceId,
  )
  // Availability decides only where a draft first opens. Once shown, it stays
  // while its project is listed, as a draft the user opened does: moving it
  // would hide what was typed, and a folder can come back. Removing the
  // project ends it the same way removal ends any draft.
  const landingWorkspaceId = !landingOpen
    ? null
    : heldLandingWorkspace
      ? heldLandingWorkspace.workspaceId
      : landingWorkspaceFor(workspaces, recentWorkspaces)
  // Leaving the landing lets go, so the next visit starts from the most recent.
  useEffect(() => setHeldLandingWorkspaceId(landingWorkspaceId), [landingWorkspaceId])
  const draftWorkspaceId = openedDraftWorkspaceId ?? landingWorkspaceId

  const isSessionDraftOpen = activeSessionId === null && draftWorkspaceId !== null
  const activeWorkspacePath = activeSessionWorkspaceId ?? draftWorkspaceId

  // A submitted prompt reads as running until the environment reports the
  // turn itself; from then on the turn is the truth.
  useEffect(() => {
    if (activeTurn) setTurnPending(false)
  }, [activeTurn])
  const localSessionStatus: LocalSessionStatus | null = pendingDraftSessionStart
    ? 'starting'
    : turnPending || activeTurn
      ? 'running'
      : null

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err))
  }, [])

  const openSessionLatest = useCallback(
    async (sessionId: string) => {
      selectionRef.current = sessionId
      if (navigateSession) {
        await navigateSession(sessionId)
        return
      }
      await commands.openSession(sessionId)
      if (selectionRef.current !== sessionId) client.setActiveSession(selectionRef.current)
    },
    [client, commands, navigateSession],
  )

  const openDraft = useCallback(
    async (workspacePath: string) => {
      const previousSessionId = activeSessionWorkspaceId === workspacePath ? activeSessionId : null
      draftGenerationRef.current += 1
      selectionRef.current = null
      setError(null)
      setDraftWorkspaceId(workspacePath)
      setPendingDraftSessionStart(false)
      setLaunchingMessage(null)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      const generation = draftGenerationRef.current
      if (navigateSession) await navigateSession(null)
      // A later selection or draft landed while the navigation settled.
      if (draftGenerationRef.current !== generation) return
      client.setActiveSession(null)
      setDraftRequest((prev) => ({
        workspacePath,
        previousSessionId,
        revision: (prev?.revision ?? 0) + 1,
      }))
    },
    [activeSessionId, activeSessionWorkspaceId, client, navigateSession],
  )

  const selectSession = useCallback(
    (_workspacePath: string, externalId: string) => {
      draftGenerationRef.current += 1
      setError(null)
      setDraftWorkspaceId(null)
      // A launch still in flight continues in the sidebar; it no longer
      // holds this composer.
      setPendingDraftSessionStart(false)
      setLaunchingMessage(null)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      void openSessionLatest(externalId).catch(fail)
    },
    [fail, openSessionLatest],
  )

  const startDraftSession = useCallback(
    async (
      text: string,
      launch: DraftLaunch,
      artifactIds?: string[],
    ): Promise<ThreadTarget | null> => {
      if (!draftWorkspaceId) throw new Error('No draft is open')
      const generation = draftGenerationRef.current
      const environmentId = client.getState().environment?.environmentId
      if (!environmentId) throw new Error('No environment is connected')
      const { providerId, preference, modeId, draft } = launch
      // One command, as the draft shows it: the environment files the picks
      // the new session is seeded from, claims the images the draft uploaded,
      // starts the provider, runs the first message in the picked mode, and
      // deletes the draft in the same write that announces the session. It
      // refuses rather than launch on anything less, so the draft stays open
      // with what was typed and attached.
      if (draft) client.drafts?.beginLaunch(draft.draftId)
      let created: Awaited<ReturnType<typeof commands.createSession>>
      try {
        created = await commands.createSession({
          environmentId,
          workspaceId: draftWorkspaceId,
          providerId,
          firstMessage: text,
          ...(preference ? { preference } : {}),
          ...(modeId !== undefined ? { modeId } : {}),
          ...(artifactIds?.length ? { artifactIds } : {}),
          ...(draft ? { draftId: draft.draftId, sessionId: draft.sessionId } : {}),
        })
      } catch (error) {
        if (draft) client.drafts?.endLaunch(draft.draftId, 'refused')
        throw error
      }
      if (draft) client.drafts?.endLaunch(draft.draftId, 'sent')
      const { session, thread } = created
      // The user moved on while the session was being created: do not pull
      // the view back to it. Its first turn continues in the sidebar.
      if (draftGenerationRef.current !== generation) return null
      // The client already holds the session, its thread and the first
      // message, so it goes on screen now, in one step. Waiting for the route
      // (and the session.open it triggers) left a gap where neither the draft
      // nor the session was showing, and the landing came back.
      selectionRef.current = session.sessionId
      client.setActiveSession(session.sessionId)
      setAdoptedDraftSessionId(session.sessionId)
      setPendingDraftSessionStart(false)
      setDraftWorkspaceId(null)
      // Creation already returned the first turn; its state now drives the composer.
      setTurnPending(false)
      // The session's own copy of the message came with it, so the echo goes in
      // the same step. Without one (an environment that leaves the first turn
      // out of its reply) the echo stays until the session's history has it.
      if (created.firstTurn) {
        setLaunchingMessage(null)
        await openSessionLatest(session.sessionId)
      } else {
        try {
          await openSessionLatest(session.sessionId)
        } finally {
          setLaunchingMessage(null)
        }
      }
      return { sessionId: session.sessionId, threadId: thread.threadId }
    },
    [client, commands, draftWorkspaceId, openSessionLatest],
  )

  const value = useMemo<SessionStateValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      launchingMessage,
      localSessionStatus,
      adoptedDraftSessionId,
      defaultProviderId,
      draftRequest,
      error,
      providerIdForSession: (sessionId, fallback) =>
        (client.getState().sessions[sessionId]?.providerId as ProviderId | undefined) ??
        fallback ??
        defaultProviderId,
      setDefaultProviderId: setDefaultProviderIdState,
      addWorkspace: async () => {
        setError(null)
        if (!addWorkspace) {
          setError('This host cannot add workspaces.')
          return
        }
        await addWorkspace().catch(fail)
      },
      removeWorkspace: async (path) => {
        setError(null)
        try {
          await commands.removeWorkspace(path)
        } catch (err) {
          fail(err)
          return
        }
        // A draft for the removed workspace has nowhere to start a session.
        if (draftWorkspaceId === path) {
          draftGenerationRef.current += 1
          setDraftWorkspaceId(null)
          setPendingDraftSessionStart(false)
          setLaunchingMessage(null)
          setTurnPending(false)
          setDraftRequest(null)
        }
      },
      selectSession,
      // The environment lists a child under its parent, so opening either
      // side is a plain session open; nothing is remembered here.
      openChildSession: async (childExternalId) => {
        setError(null)
        await openSessionLatest(childExternalId)
      },
      closeChildSession: (parentExternalId) => {
        void openSessionLatest(parentExternalId).catch(fail)
      },
      createSession: async (workspacePath) => openDraft(workspacePath),
      renameSession: async (_workspacePath, externalId, title) => {
        setError(null)
        await commands.renameSession(externalId, title).catch(fail)
      },
      regenerateSessionTitle: async (externalId) => {
        setError(null)
        await commands.regenerateSessionTitle(externalId).catch(fail)
      },
      deleteSession: async (_workspacePath, externalId) => {
        setError(null)
        await commands.deleteSession(externalId).catch(fail)
      },
      beginDraftTurn: (message) => {
        setError(null)
        setPendingDraftSessionStart(true)
        if (message) setLaunchingMessage(message)
      },
      beginSessionTurn: () => {
        setError(null)
        setTurnPending(true)
      },
      attachTurnJob: () => undefined,
      failTurn: (message) => {
        setPendingDraftSessionStart(false)
        // The composer puts the text back; the transcript lets it go.
        setLaunchingMessage(null)
        setTurnPending(false)
        if (message) setError(message)
      },
    }),
    [
      activeSessionId,
      activeWorkspacePath,
      addWorkspace,
      adoptedDraftSessionId,
      client,
      commands,
      defaultProviderId,
      draftRequest,
      draftWorkspaceId,
      error,
      fail,
      isSessionDraftOpen,
      launchingMessage,
      localSessionStatus,
      openDraft,
      openSessionLatest,
      pendingDraftSessionStart,
      selectSession,
    ],
  )
  const internals = useMemo<DraftInternals>(() => ({ startDraftSession }), [startDraftSession])

  return (
    <SessionStateContext.Provider value={value}>
      <DraftInternalsContext.Provider value={internals}>{children}</DraftInternalsContext.Provider>
    </SessionStateContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Sidebar data: the catalog, grouped; folded rows remembered in storage.
// ---------------------------------------------------------------------------

function readCollapsed(storage: EnvironmentApplicationOptions['collapsedWorkspaceStorage']) {
  try {
    const raw = storage?.getItem(COLLAPSED_WORKSPACES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function toWorkspaceEntry(workspace: Workspace): WorkspaceEntry {
  return {
    path: workspace.workspaceId,
    name: workspace.name,
    missing: !workspace.exists,
    availability: workspace.availability,
    lastActivityAt: workspace.lastActivityAt,
    capabilities: workspace.capabilities,
    ...(workspace.git ? { git: workspace.git } : {}),
  }
}

function EnvironmentSidebarDataProvider({
  storage: storageOption,
  children,
}: {
  storage?: EnvironmentApplicationOptions['collapsedWorkspaceStorage']
  children: ReactNode
}) {
  const client = useEnvironmentClient()
  const session = useContext(SessionStateContext)!
  const environmentState = useEnvironmentState((state) => state.environment)
  const workspaces = useWorkspaces()
  const recentWorkspaces = useRecentWorkspaces()
  const sessions = useSessionList()
  const connection = useConnectionState()
  const storage = storageOption === undefined ? defaultStorage() : storageOption
  const [collapsedWorkspacePaths, setCollapsed] = useState<string[]>(() => readCollapsed(storage))

  const toggleWorkspaceCollapsed = useCallback(
    (workspacePath: string) => {
      setCollapsed((prev) => {
        const next = toggleCollapsedWorkspace(prev, workspacePath)
        try {
          storage?.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify(next))
        } catch {
          /* best effort */
        }
        return next
      })
    },
    [storage],
  )

  const environment = useMemo<SidebarEnvironment | undefined>(() => {
    const label = environmentState?.name.trim()
    return environmentState && label
      ? { environmentId: environmentState.environmentId, label }
      : undefined
  }, [environmentState])
  const workspaceEntries = useMemo(() => workspaces.map(toWorkspaceEntry), [workspaces])
  const recentEntries = useMemo(() => recentWorkspaces.map(toWorkspaceEntry), [recentWorkspaces])
  // What the sidebar was last handed, so an unchanged row stays the same object.
  const shownSessions = useRef<SidebarSessionsByWorkspace | null>(null)
  const sessionsByWorkspace = useMemo(() => {
    const grouped: SidebarSessionsByWorkspace = {}
    const unavailableWorkspaces = new Set(
      workspaceEntries
        .filter((workspace) =>
          workspace.availability ? workspace.availability !== 'available' : workspace.missing,
        )
        .map((workspace) => workspace.path),
    )
    for (const summary of sessions) {
      const entry: SidebarSessionEntry = {
        externalId: summary.sessionId,
        title: summary.title ?? undefined,
        // Idle with an unseen completion is done until someone opens it. Plain
        // server idle means ready; legacy desktop idle clears an unread
        // completion marker, so keep the presentation alias at this boundary.
        status: summary.status === 'idle' ? (summary.doneAt ? 'done' : 'ready') : summary.status,
        providerId: (summary.providerId as ProviderId | undefined) ?? session.defaultProviderId,
        ...(summary.parentSessionId ? { parentExternalId: summary.parentSessionId } : {}),
        // ChatView still branches on `isDriven` for the Convex IPC overlay.
        // This path has one protocol-event stream and no `stream_chunks`
        // subscription, so the flag is always true. Desktop must drop the
        // overlay at thin-shell cutover rather than reintroduce `driven`.
        isDriven: true,
        ...(unavailableWorkspaces.has(summary.workspaceId) ? { workspaceUnavailable: true } : {}),
        ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
        settledAt: summary.settledAt ?? null,
      }
      ;(grouped[summary.workspaceId] ??= []).push(entry)
    }
    shownSessions.current = reuseUnchanged(shownSessions.current, grouped)
    return shownSessions.current
  }, [session.defaultProviderId, sessions, workspaceEntries])

  // Offered only once the environment says it can keep the change.
  const canSettle = connection.phase === 'connected' && client.supports('settleSession')
  const settleSession = useCallback(
    (_workspacePath: string, externalId: string, settled: boolean) =>
      client.commands.settleSession(externalId, settled),
    [client],
  )

  const canRegenerateTitle =
    connection.phase === 'connected' && client.supports('regenerateSessionTitle')
  const canAcknowledge = connection.phase === 'connected' && client.supports('acknowledgeSession')
  const acknowledgeSessionDone = useCallback(
    (_workspacePath: string, externalId: string) => client.commands.acknowledgeSession(externalId),
    [client],
  )

  const isWorkspacesLoading =
    workspaces.length === 0 &&
    (connection.phase === 'idle' || connection.phase === 'connecting') &&
    !connection.hasConnected

  const value = useMemo<SidebarDataValue>(
    () => ({
      environment,
      workspaces: workspaceEntries,
      recentWorkspaces: recentEntries,
      isWorkspacesLoading,
      activeWorkspacePath: session.activeWorkspacePath,
      activeSessionId: session.activeSessionId,
      collapsedWorkspacePaths,
      toggleWorkspaceCollapsed,
      addWorkspace: session.addWorkspace,
      removeWorkspace: session.removeWorkspace,
      selectSession: session.selectSession,
      createSession: session.createSession,
      renameSession: session.renameSession,
      ...(canRegenerateTitle && session.regenerateSessionTitle
        ? { regenerateSessionTitle: session.regenerateSessionTitle }
        : {}),
      ...(canSettle ? { settleSession } : {}),
      ...(canAcknowledge ? { acknowledgeSessionDone } : {}),
      deleteSession: session.deleteSession,
    }),
    [
      canSettle,
      settleSession,
      canRegenerateTitle,
      session.regenerateSessionTitle,
      canAcknowledge,
      acknowledgeSessionDone,
      collapsedWorkspacePaths,
      environment,
      isWorkspacesLoading,
      recentEntries,
      session.activeSessionId,
      session.activeWorkspacePath,
      session.addWorkspace,
      session.createSession,
      session.renameSession,
      session.deleteSession,
      session.removeWorkspace,
      session.selectSession,
      toggleWorkspaceCollapsed,
      workspaceEntries,
    ],
  )
  return (
    <SidebarDataContext.Provider value={value}>
      <SidebarSessionsContext.Provider value={sessionsByWorkspace}>
        {children}
      </SidebarSessionsContext.Provider>
    </SidebarDataContext.Provider>
  )
}

/**
 * The next grouping, keeping every row and group whose shown fields did not
 * change as the object it was. Sessions carry more than the sidebar shows
 * (the composer selection, thread ids) and a listing rebuilds them all; a
 * change the sidebar does not show then leaves the whole value as it was.
 */
function reuseUnchanged(
  previous: SidebarSessionsByWorkspace | null,
  next: SidebarSessionsByWorkspace,
): SidebarSessionsByWorkspace {
  if (!previous) return next
  const rows = new Map<string, SidebarSessionEntry>()
  for (const group of Object.values(previous)) {
    for (const row of group) rows.set(row.externalId, row)
  }
  let changed = Object.keys(previous).length !== Object.keys(next).length
  const result: SidebarSessionsByWorkspace = {}
  for (const [path, group] of Object.entries(next)) {
    const kept = group.map((row) => {
      const before = rows.get(row.externalId)
      return before && sameEntry(before, row) ? before : row
    })
    const before = previous[path]
    const same =
      before !== undefined &&
      before.length === kept.length &&
      kept.every((row, index) => row === before[index])
    result[path] = same ? before : kept
    if (!same) changed = true
  }
  return changed ? result : previous
}

function sameEntry(left: SidebarSessionEntry, right: SidebarSessionEntry): boolean {
  const keys = Object.keys(left) as (keyof SidebarSessionEntry)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  )
}

// ---------------------------------------------------------------------------
// Active thread: rows projected from the thread, commands through the client.
// ---------------------------------------------------------------------------

function permissionResponse(
  interaction: Extract<PendingInteraction['interaction'], { kind: 'permission' }>,
  selection: PermissionSelection,
): InteractionResponse {
  const optionId =
    'optionId' in selection
      ? selection.optionId
      : interaction.options.find((option) =>
          selection.approved
            ? option.kind === 'allow_once' || option.kind === 'allow_always'
            : option.kind === 'reject_once' || option.kind === 'reject_always',
        )?.optionId
  if (!optionId) throw new Error('No matching permission option')
  return {
    kind: 'permission',
    interactionId: interaction.interactionId,
    outcome: { outcome: 'selected', optionId },
  }
}

function EnvironmentActiveThreadProvider({ children }: { children: ReactNode }) {
  const client = useEnvironmentClient()
  const { commands } = client
  const session = useContext(SessionStateContext)!
  const { ensureProvider, providerDisplayName } = useContext(PlatformCapabilitiesContext)!
  const { startDraftSession } = useContext(DraftInternalsContext)!
  const { draftLaunch, draftLaunched } = useContext(DraftLaunchContext)!
  const activeSession = useActiveSession()
  const thread = useActiveThread()
  const activeTurn = useActiveTurn()
  const [error, setError] = useState<string | null>(null)

  const stores = useMemo(() => createEnvironmentThreadStores(client), [client])
  const projection = useEnvironmentState(stores.select)

  // Built from the fields it shows, so a settle or a composer pick on the
  // session does not re-render the thread.
  const listedSessionId = activeSession?.sessionId
  const activeTitle = activeSession?.title ?? undefined
  // A session held at running only by background work has no turn to wait
  // for or to stop: the composer is free, and the pill above it says what is
  // still running and stops it.
  const activeStatus =
    activeSession?.status === 'running' && !activeTurn && activeSession.backgroundTasks?.length
      ? 'idle'
      : activeSession?.status
  const activeParentId = activeSession?.parentSessionId
  const activeThread = useMemo<ActiveThreadDetails | null>(
    () =>
      listedSessionId && activeStatus
        ? {
            externalId: listedSessionId,
            title: activeTitle,
            status: activeStatus,
            ...(activeParentId ? { parentExternalId: activeParentId } : {}),
            // Same shim as the sidebar: one projection, not owner-vs-observer.
            isDriven: true,
          }
        : null,
    [activeParentId, listedSessionId, activeStatus, activeTitle],
  )

  const target = thread?.thread ?? null
  const targetRef = useRef(target)
  targetRef.current = target

  const { beginDraftTurn, beginSessionTurn, failTurn, isSessionDraftOpen } = session
  const { activeWorkspacePath, launchingMessage } = session

  // A draft's first message is on screen from the moment it is sent, not from
  // when its session exists: the transcript shows it while the session is
  // created, and the session's own copy takes its place in the same frame
  // the session does.
  const launchRow = useMemo<UIMessage | null>(
    () =>
      launchingMessage
        ? {
            externalId: 'launch',
            role: 'user',
            isFinal: true,
            sequenceNum: 0,
            optimisticContent: launchingMessage.text,
            ...(launchingMessage.images.length
              ? { optimisticAttachments: launchingMessage.images }
              : {}),
            isOptimistic: true,
          }
        : null,
    [launchingMessage],
  )
  const messages = useMemo(
    () =>
      launchRow && (!target || projection.messages.length === 0)
        ? [launchRow]
        : projection.messages,
    [launchRow, projection.messages, target],
  )

  const sendMessage = useCallback(
    async (content: string, attachments?: UploadedImageAttachment[]) => {
      const text = content.trim()
      // An image with no caption is still a turn.
      if (!text && !attachments?.length) {
        // The composer may already have announced a launch; nothing to send
        // must not leave it held.
        if (!targetRef.current && isSessionDraftOpen) failTurn()
        return
      }
      setError(null)
      try {
        // An upload is bound to the session it was stored under or, from a
        // draft, held for that draft's workspace. One that finished after the
        // user moved elsewhere would be refused by the environment with the
        // whole turn, so refuse here and keep the text.
        const draftWorkspaceId =
          !targetRef.current && isSessionDraftOpen ? activeWorkspacePath : null
        // A host's own uploader may name neither, and is left to the host.
        if (
          attachments?.some((attachment) =>
            draftWorkspaceId
              ? attachment.sessionId !== undefined ||
                (attachment.workspaceId !== undefined &&
                  attachment.workspaceId !== draftWorkspaceId)
              : attachment.workspaceId !== undefined ||
                (attachment.sessionId !== undefined &&
                  attachment.sessionId !== targetRef.current?.sessionId),
          )
        ) {
          throw new Error('These images were uploaded for another chat. Attach them again.')
        }
        // An uploaded attachment's id is the artifact the environment stored.
        const artifactIds = attachments?.map((attachment) => attachment.id)
        if (!targetRef.current && isSessionDraftOpen) {
          beginDraftTurn()
          // Refused here rather than by the environment's rejection: the user
          // learns why before a session exists, and keeps what they typed.
          const launch = draftLaunch(activeWorkspacePath ?? '')
          if (!(await ensureProvider(launch.providerId, activeWorkspacePath ?? ''))) {
            throw new Error(
              `${providerDisplayName(launch.providerId)} is unavailable. Retry it from Settings.`,
            )
          }
          await startDraftSession(text, launch, artifactIds)
          draftLaunched(activeWorkspacePath ?? '', launch)
          return
        }
        const current = targetRef.current
        // A session still opening has no thread to send to yet. Refused
        // rather than dropped, so the composer puts the text back.
        if (!current) throw new Error('This session is still opening. Send again once it loads.')
        beginSessionTurn()
        // A rejected send keeps its own row on screen with the reason and a
        // retry, so it is neither an error banner nor a composer rollback.
        await commands
          .sendTurn({ ...current, text, ...(artifactIds?.length ? { artifactIds } : {}) })
          .catch(() => failTurn())
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failTurn(message)
        setError(message)
        throw err
      }
    },
    [
      activeWorkspacePath,
      beginDraftTurn,
      beginSessionTurn,
      commands,
      draftLaunch,
      draftLaunched,
      ensureProvider,
      failTurn,
      isSessionDraftOpen,
      providerDisplayName,
      startDraftSession,
    ],
  )

  const retrySend = useCallback(
    async (commandId: string) => {
      const current = targetRef.current
      if (!current) return
      const pending = client
        .getState()
        .threads[current.threadId]?.outbox.find((entry) => entry.commandId === commandId)
      if (!pending) return
      setError(null)
      beginSessionTurn()
      // The same id: the environment either starts the turn or answers with
      // the one this send already started.
      await commands
        .sendTurn({
          ...current,
          text: pending.text,
          ...(pending.artifactIds ? { artifactIds: pending.artifactIds } : {}),
          commandId,
        })
        .catch(() => failTurn())
    },
    [beginSessionTurn, client, commands, failTurn],
  )

  const respond = useCallback(
    async (threadId: string, response: InteractionResponse) => {
      const state = client.getState()
      const current = state.threads[threadId]
      if (!current) return
      setError(null)
      try {
        await commands.respondToInteraction({ ...current.thread, response })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        throw err
      }
    },
    [client, commands],
  )

  const findInteraction = useCallback(
    (sessionId: string, interactionId: string) => {
      const state = client.getState()
      const summary = state.sessions[sessionId]
      for (const threadId of summary?.threadIds ?? []) {
        const pending = state.threads[threadId]?.interactions.find(
          (item) => item.interaction.interactionId === interactionId,
        )
        if (pending) return pending
      }
      return null
    },
    [client],
  )

  const historyRequests = useRef(new Set<string>())
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null)
  const loadMoreHistory = useCallback(async () => {
    const current = client.getState()
    const target = current.activeThreadId ? current.threads[current.activeThreadId] : undefined
    if (!target?.historyCursor || historyRequests.current.has(target.thread.threadId)) return
    const threadId = target.thread.threadId
    historyRequests.current.add(threadId)
    setLoadingHistory(threadId)
    setError(null)
    try {
      await commands.loadSessionHistory({ ...target.thread, cursor: target.historyCursor })
    } catch (err) {
      if (client.getState().activeThreadId === threadId) {
        setError(err instanceof Error ? err.message : 'Could not load older messages.')
      }
    } finally {
      historyRequests.current.delete(threadId)
      setLoadingHistory((id) => (id === threadId ? null : id))
    }
  }, [client, commands])

  // A session picked before its threads are known is still opening: they
  // arrive with `session.open`, and until then it loads like any thread.
  const hydration = thread ? thread.hydration : session.activeSessionId ? 'loading' : null

  const value = useMemo<ActiveThreadStateValue>(
    () => ({
      activeSessionId: session.activeSessionId,
      activeThread,
      // Compatibility shim so ChatView reads `streamingStore`. There is no
      // `remoteStreamingStore` on this path (that would be Convex stream_chunks).
      activeThreadDriven: true,
      isMessagesLoading: hydration === 'loading',
      history: {
        failed: hydration === 'failed',
        retry: async () => {
          if (session.activeSessionId)
            await commands
              .openSession(session.activeSessionId)
              .catch((err) =>
                setError(err instanceof Error ? err.message : 'Could not load history.'),
              )
        },
        hasMore: !!thread?.historyCursor,
        isLoading: loadingHistory === thread?.thread.threadId,
        loadMore: loadMoreHistory,
      },
      messages,
      streamingStore: stores.streamingStore,
      messageContentStore: stores.messageContentStore,
      error,
      acknowledgeOptimisticMessage: noop,
      sendMessage,
      retrySend,
      abortSession: async () => {
        const current = targetRef.current
        if (!current || !activeTurn) return
        setError(null)
        await commands
          .interruptTurn({ ...current, turnId: activeTurn.turnId })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      },
      resolvePermission: async (sessionId, permissionId, selection) => {
        const pending = findInteraction(sessionId, permissionId)
        if (!pending || pending.interaction.kind !== 'permission') return
        await respond(pending.threadId, permissionResponse(pending.interaction, selection))
      },
      resolveQuestion: async (sessionId, requestId, outcome: QuestionOutcome) => {
        const pending = findInteraction(sessionId, requestId)
        if (!pending || pending.interaction.kind !== 'question') return
        await respond(pending.threadId, { kind: 'question', interactionId: requestId, outcome })
      },
      resolvePlan: async (sessionId, requestId, outcome: PlanReviewOutcome) => {
        const pending = findInteraction(sessionId, requestId)
        if (!pending || pending.interaction.kind !== 'plan') return
        await respond(pending.threadId, { kind: 'plan', interactionId: requestId, outcome })
      },
      buildPlan: async (sessionId, requestId) => {
        const pending = findInteraction(sessionId, requestId)
        if (!pending || pending.interaction.kind !== 'plan') return
        await respond(pending.threadId, {
          kind: 'plan',
          interactionId: requestId,
          outcome: { outcome: 'accepted' },
        })
      },
    }),
    [
      activeThread,
      activeTurn,
      commands,
      error,
      findInteraction,
      messages,
      respond,
      retrySend,
      sendMessage,
      session.activeSessionId,
      stores,
      hydration,
      thread?.historyCursor,
      thread?.thread.threadId,
      loadingHistory,
      loadMoreHistory,
    ],
  )

  // Intentionally no `remoteStreamingStore`: that would subscribe to Convex
  // `stream_chunks`. Live turns are already in `streamingStore`.
  const threadStores = useMemo<ActiveThreadStores>(
    () => ({
      streamingStore: stores.streamingStore,
      messageContentStore: stores.messageContentStore,
    }),
    [stores],
  )

  return (
    <ActiveThreadStoresContext.Provider value={threadStores}>
      <ActiveThreadStateContext.Provider value={value}>
        {children}
      </ActiveThreadStateContext.Provider>
    </ActiveThreadStoresContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Interaction panels: pending interactions of the active thread, by kind.
// ---------------------------------------------------------------------------

function toPendingPermission(pending: PendingInteraction, at: number): PendingPermission | null {
  const { interaction } = pending
  if (interaction.kind !== 'permission') return null
  return {
    requestId: interaction.interactionId,
    toolCallId: interaction.toolCall.toolCallId,
    permission: interaction.toolCall.kind,
    toolName: interaction.toolCall.title,
    description: interaction.toolCall.title,
    options: interaction.options as PermissionOption[],
    ...(interaction.expiresAt ? { expiresAt: Date.parse(interaction.expiresAt) } : {}),
    createdAt: at,
    updatedAt: at,
  }
}

function toPendingQuestion(pending: PendingInteraction, at: number): PendingQuestion | null {
  const { interaction } = pending
  if (interaction.kind !== 'question') return null
  return {
    requestId: interaction.interactionId,
    title: interaction.title,
    questions: interaction.questions,
    createdAt: at,
    updatedAt: at,
  }
}

function toPlanRow(pending: PendingInteraction, at: number): PlanRow | null {
  const { interaction } = pending
  if (interaction.kind !== 'plan') return null
  return {
    requestId: interaction.interactionId,
    name: interaction.name,
    overview: interaction.overview,
    markdown: interaction.markdown,
    todos: interaction.todos,
    phases: interaction.phases,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
  }
}

/** First pending interaction of each kind on the active thread, converted once
 * per interaction object. With no active thread (a draft is open) there is
 * nothing to answer: the unscoped selector would otherwise surface another
 * session's request over the draft composer. */
function useInteractionsByKind() {
  // Only the id: the thread itself is a new object on every streamed event,
  // and reading it here would render the interaction providers for each.
  const threadId = useEnvironmentState(selectActiveThreadId)
  const scoped = usePendingInteractions(threadId)
  const interactions = threadId ? scoped : EMPTY_LIST
  const cache = useRef(new WeakMap<PendingInteraction, { at: number }>())
  return useMemo(() => {
    const stamp = (pending: PendingInteraction) => {
      let entry = cache.current.get(pending)
      if (!entry) {
        entry = { at: Date.now() }
        cache.current.set(pending, entry)
      }
      return entry.at
    }
    let permission: PendingPermission | null = null
    let question: PendingQuestion | null = null
    let plan: PlanRow | null = null
    for (const pending of interactions) {
      permission ??= toPendingPermission(pending, stamp(pending))
      question ??= toPendingQuestion(pending, stamp(pending))
      plan ??= toPlanRow(pending, stamp(pending))
    }
    return { permission, question, plan }
  }, [interactions])
}

function EnvironmentInteractionProviders({ children }: { children: ReactNode }) {
  const { activeSessionId } = useContext(SessionStateContext)!
  const {
    resolvePermission: resolveSessionPermission,
    resolveQuestion: resolveSessionQuestion,
    resolvePlan: resolveSessionPlan,
  } = useContext(ActiveThreadStateContext)!
  const { permission, question, plan } = useInteractionsByKind()
  const planHistory = useMemo(() => (plan ? [plan] : EMPTY_LIST), [plan])

  const resolvePermission = useCallback(
    async (selection: PermissionSelection) => {
      if (!activeSessionId || !permission) return
      await resolveSessionPermission(activeSessionId, permission.requestId, selection)
    },
    [activeSessionId, permission, resolveSessionPermission],
  )
  const resolveQuestion = useCallback(
    async (outcome: QuestionOutcome) => {
      if (!activeSessionId || !question) return
      await resolveSessionQuestion(activeSessionId, question.requestId, outcome)
    },
    [activeSessionId, question, resolveSessionQuestion],
  )
  const resolvePlan = useCallback(
    async (outcome: PlanReviewOutcome) => {
      if (!activeSessionId || !plan) return
      await resolveSessionPlan(activeSessionId, plan.requestId, outcome)
    },
    [activeSessionId, plan, resolveSessionPlan],
  )

  return (
    <PermissionStateProvider
      activeSessionId={activeSessionId}
      pendingPermission={permission}
      resolvePermission={resolvePermission}
    >
      <QuestionStateProvider
        activeSessionId={activeSessionId}
        pendingQuestion={question}
        resolveQuestion={resolveQuestion}
      >
        <PlanStateProvider
          activeSessionId={activeSessionId}
          planHistory={planHistory}
          resolvePlan={resolvePlan}
        >
          {children}
        </PlanStateProvider>
      </QuestionStateProvider>
    </PermissionStateProvider>
  )
}

function EnvironmentViewActions({
  actions,
  children,
}: {
  actions?: Omit<ViewActions, 'activeSessionId'>
  children: ReactNode
}) {
  const { activeSessionId, activeWorkspacePath, isSessionDraftOpen, openChildSession } =
    useContext(SessionStateContext)!
  const client = useEnvironmentClient()
  // Sidebar rows carry the workspace ID as their `path`, so the icon lookup
  // is the environment's own `workspace.icon` read. The function's identity
  // doubles as the icon cache key downstream, so it changes only when the
  // client or its advertised capabilities do; a failed lookup is a plain
  // fallback, never an error the view has to handle.
  const capabilities = useConnectionState().capabilities
  const iconsSupported = capabilities.includes('workspace.icon')
  const resolveWorkspaceIcon = useMemo(
    () =>
      iconsSupported && client.supports('resolveWorkspaceIcon')
        ? (workspaceId: string) =>
            client.commands.resolveWorkspaceIcon(workspaceId).catch(() => null)
        : undefined,
    [client, iconsSupported],
  )
  // Composer images go to the environment itself: a ticket per file, then
  // the bytes over its authorized route. The uploader is offered only when
  // the client has that route and the environment advertises tickets, so a
  // host that cannot store images shows no attach affordance at all. An
  // upload belongs to the open session or, from a draft, which has no session
  // yet, is held for the draft's workspace until the launch claims it.
  const uploadsSupported = capabilities.includes(UPLOAD_TICKET_COMMAND) && !!client.uploadArtifact
  const uploadScope: UploadScope | null = activeSessionId
    ? { sessionId: activeSessionId }
    : isSessionDraftOpen && activeWorkspacePath
      ? { workspaceId: activeWorkspacePath }
      : null
  const uploadScopeRef = useRef(uploadScope)
  uploadScopeRef.current = uploadScope
  const uploadAttachments = useMemo(
    () =>
      uploadsSupported
        ? async (drafts: DraftImageAttachment[]): Promise<UploadedImageAttachment[]> => {
            const scope = uploadScopeRef.current
            if (!scope) throw new Error('Open a chat to attach images.')
            const uploaded: UploadedImageAttachment[] = []
            for (const draft of drafts) {
              // Navigating away mid-batch: stop storing files for a chat the
              // send will no longer target. What is already stored has no
              // release route; retention on the environment sweeps it.
              if (!sameUploadScope(uploadScopeRef.current, scope)) {
                throw new Error('The chat changed while images were uploading.')
              }
              const stored = await client.uploadArtifact!({
                ...scope,
                name: draft.file.name,
                mimeType: draft.file.type,
                bytes: draft.file,
              })
              uploaded.push({
                id: stored.artifactId,
                name: stored.name,
                mimeType: stored.mimeType,
                size: stored.sizeBytes,
                previewUrl: draft.previewUrl,
                ...scope,
              })
            }
            return uploaded
          }
        : undefined,
    [client, uploadsSupported],
  )
  const value = useMemo<ViewActions>(
    () => ({
      openChildSession,
      resolveWorkspaceIcon,
      uploadAttachments,
      ...actions,
      activeSessionId,
    }),
    [actions, activeSessionId, openChildSession, resolveWorkspaceIcon, uploadAttachments],
  )
  return <ViewActionsContext.Provider value={value}>{children}</ViewActionsContext.Provider>
}
