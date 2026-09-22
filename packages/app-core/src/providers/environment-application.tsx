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
  selectProviderCatalog,
  shallowEqualArray,
  type PendingInteraction,
  type ProviderCatalogEntry,
  type ThreadTarget,
} from '@openmanager/environment-client'
import type { UploadedImageAttachment } from '../lib/attachments'
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
  type LocalSessionStatus,
  type SessionStateValue,
} from './session-provider'
import {
  DraftLaunchContext,
  EnvironmentComposerStateProvider,
  type DraftLaunch,
} from './environment-composer'
import {
  SidebarDataContext,
  toggleCollapsedWorkspace,
  type SidebarDataValue,
  type SidebarEnvironment,
  type SidebarSessionEntry,
  type WorkspaceEntry,
} from './sidebar-provider'
import {
  ActiveThreadStateContext,
  ActiveThreadStoresContext,
  type ActiveThreadDetails,
  type ActiveThreadStateValue,
  type ActiveThreadStores,
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

const EMPTY_RECORD = {}
/** Stable identity: an inline callback here re-renders every message row. */
const noop = () => undefined
const EMPTY_LIST: never[] = []

export interface EnvironmentApplicationOptions {
  /** How this host lets the user add a workspace; absent means it cannot. */
  addWorkspace?: () => Promise<void>
  /** Routed hosts navigate first; the destination owns session hydration. */
  navigateSession?: (sessionId: string | null) => Promise<void>
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
      >
        <EnvironmentComposerStateProvider>
          <EnvironmentSidebarDataProvider storage={options.collapsedWorkspaceStorage}>
            <EnvironmentActiveThreadProvider>
              <EnvironmentInteractionProviders>
                <EnvironmentViewActions actions={options.viewActions}>
                  {children}
                </EnvironmentViewActions>
              </EnvironmentInteractionProviders>
            </EnvironmentActiveThreadProvider>
          </EnvironmentSidebarDataProvider>
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
    }
    return {
      providers,
      providerHealthByProvider,
      agentUiStatusByProvider,
      acpAgentInfoByProvider,
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
      acpPromptCapabilitiesByProvider: EMPTY_RECORD,
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
  startDraftSession: (text: string, launch: DraftLaunch) => Promise<ThreadTarget | null>
}

const DraftInternalsContext = createContext<DraftInternals | null>(null)

function EnvironmentSessionStateProvider({
  addWorkspace,
  navigateSession,
  children,
}: {
  addWorkspace?: () => Promise<void>
  navigateSession?: (sessionId: string | null) => Promise<void>
  children: ReactNode
}) {
  const client = useEnvironmentClient()
  const { commands } = client
  const activeSession = useActiveSession()
  const activeTurn = useActiveTurn()
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null)
  const [pendingDraftSessionStart, setPendingDraftSessionStart] = useState(false)
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

  const activeSessionId = activeSession?.sessionId ?? null
  const isSessionDraftOpen = activeSessionId === null && draftWorkspaceId !== null
  const activeWorkspacePath = activeSession?.workspaceId ?? draftWorkspaceId

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
      const previousSessionId =
        activeSession?.workspaceId === workspacePath ? activeSession.sessionId : null
      draftGenerationRef.current += 1
      selectionRef.current = null
      setError(null)
      setDraftWorkspaceId(workspacePath)
      setPendingDraftSessionStart(false)
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
    [activeSession, client, navigateSession],
  )

  const selectSession = useCallback(
    (_workspacePath: string, externalId: string) => {
      draftGenerationRef.current += 1
      setError(null)
      setDraftWorkspaceId(null)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      void openSessionLatest(externalId).catch(fail)
    },
    [fail, openSessionLatest],
  )

  const startDraftSession = useCallback(
    async (text: string, launch: DraftLaunch): Promise<ThreadTarget | null> => {
      if (!draftWorkspaceId) throw new Error('No draft is open')
      const generation = draftGenerationRef.current
      const environmentId = client.getState().environment?.environmentId
      if (!environmentId) throw new Error('No environment is connected')
      const { providerId, preference, modeId } = launch
      // The environment seeds a new session's model and settings from the
      // workspace preference, so the draft's picks are filed there first. A
      // failure stops the launch: starting on something else would be worse.
      // The composer refuses picks this environment cannot act on, so these
      // only trip if that changed under an open draft. Never launch on less
      // than what the composer shows.
      if (
        (preference && !client.supports('setComposerPreference')) ||
        (modeId !== undefined && !client.supports('setSessionMode'))
      ) {
        throw new Error('This environment cannot start a chat with the selected settings.')
      }
      if (preference) {
        await commands.setComposerPreference({
          workspaceId: draftWorkspaceId,
          providerId,
          preference,
        })
      }
      // A mode has to be set on a session that exists and before its first
      // prompt, so that launch is create, switch, send rather than one command.
      const switchMode = modeId !== undefined
      const { session, thread } = await commands.createSession({
        environmentId,
        workspaceId: draftWorkspaceId,
        providerId,
        ...(switchMode ? {} : { firstMessage: text }),
      })
      const target = { sessionId: session.sessionId, threadId: thread.threadId }
      if (switchMode) {
        try {
          await commands.setSessionMode({ sessionId: session.sessionId, modeId })
        } catch (err) {
          // Prompting in the wrong mode (agent instead of plan) is not a
          // fallback. The draft stays open with what was typed.
          await commands.deleteSession(session.sessionId).catch(() => undefined)
          throw err
        }
      }
      if (draftGenerationRef.current !== generation) {
        // The user moved on while the session was being created: do not pull
        // the view back to it. Its first turn continues in the sidebar.
        if (switchMode) void commands.sendTurn({ ...target, text }).catch(() => undefined)
        return null
      }
      await openSessionLatest(session.sessionId)
      setAdoptedDraftSessionId(session.sessionId)
      setPendingDraftSessionStart(false)
      setDraftWorkspaceId(null)
      if (switchMode) {
        setTurnPending(true)
        // As with any send, a refused prompt keeps its own row and retry.
        await commands.sendTurn({ ...target, text }).catch(() => setTurnPending(false))
      } else {
        // Creation already returned the first turn; its state now drives the composer.
        setTurnPending(false)
      }
      return target
    },
    [client, commands, draftWorkspaceId, openSessionLatest],
  )

  const value = useMemo<SessionStateValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
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
      deleteSession: async (_workspacePath, externalId) => {
        setError(null)
        await commands.deleteSession(externalId).catch(fail)
      },
      beginDraftTurn: () => {
        setError(null)
        setPendingDraftSessionStart(true)
      },
      beginSessionTurn: () => {
        setError(null)
        setTurnPending(true)
      },
      attachTurnJob: () => undefined,
      failTurn: (message) => {
        setPendingDraftSessionStart(false)
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
  }
}

function EnvironmentSidebarDataProvider({
  storage: storageOption,
  children,
}: {
  storage?: EnvironmentApplicationOptions['collapsedWorkspaceStorage']
  children: ReactNode
}) {
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
  const sessionsByWorkspace = useMemo(() => {
    const grouped: Record<string, SidebarSessionEntry[]> = {}
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
        // Server idle means ready. Legacy desktop idle clears an unread
        // completion marker, so keep the presentation alias at this boundary.
        status: summary.status === 'idle' ? 'ready' : summary.status,
        providerId: (summary.providerId as ProviderId | undefined) ?? session.defaultProviderId,
        ...(summary.parentSessionId ? { parentExternalId: summary.parentSessionId } : {}),
        // ChatView still branches on `isDriven` for the Convex IPC overlay.
        // This path has one protocol-event stream and no `stream_chunks`
        // subscription, so the flag is always true. Desktop must drop the
        // overlay at thin-shell cutover rather than reintroduce `driven`.
        isDriven: true,
        ...(unavailableWorkspaces.has(summary.workspaceId) ? { workspaceUnavailable: true } : {}),
      }
      ;(grouped[summary.workspaceId] ??= []).push(entry)
    }
    return grouped
  }, [session.defaultProviderId, sessions, workspaceEntries])

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
      sessionsByWorkspace,
      activeWorkspacePath: session.activeWorkspacePath,
      activeSessionId: session.activeSessionId,
      collapsedWorkspacePaths,
      toggleWorkspaceCollapsed,
      addWorkspace: session.addWorkspace,
      removeWorkspace: session.removeWorkspace,
      selectSession: session.selectSession,
      createSession: session.createSession,
      renameSession: session.renameSession,
      deleteSession: session.deleteSession,
    }),
    [
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
      sessionsByWorkspace,
      toggleWorkspaceCollapsed,
      workspaceEntries,
    ],
  )
  return <SidebarDataContext.Provider value={value}>{children}</SidebarDataContext.Provider>
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

  const activeThread = useMemo<ActiveThreadDetails | null>(
    () =>
      activeSession
        ? {
            externalId: activeSession.sessionId,
            title: activeSession.title ?? undefined,
            status: activeSession.status,
            ...(activeSession.parentSessionId
              ? { parentExternalId: activeSession.parentSessionId }
              : {}),
            // Same shim as the sidebar: one projection, not owner-vs-observer.
            isDriven: true,
          }
        : null,
    [activeSession],
  )

  const target = thread?.thread ?? null
  const targetRef = useRef(target)
  targetRef.current = target

  const { beginDraftTurn, beginSessionTurn, failTurn, isSessionDraftOpen } = session
  const { activeWorkspacePath } = session

  const sendMessage = useCallback(
    async (content: string, attachments?: UploadedImageAttachment[]) => {
      const text = content.trim()
      if (!text) return
      setError(null)
      try {
        // An upload belongs to a session, and a draft has none yet; refusing
        // beats silently dropping an image the composer just confirmed.
        if (attachments?.length && !targetRef.current) {
          throw new Error('Images can be attached once the session has started.')
        }
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
          await startDraftSession(text, launch)
          draftLaunched(activeWorkspacePath ?? '', launch)
          return
        }
        const current = targetRef.current
        if (!current) return
        beginSessionTurn()
        // A rejected send keeps its own row on screen with the reason and a
        // retry, so it is neither an error banner nor a composer rollback.
        // An uploaded attachment's id is the artifact the environment stored.
        const artifactIds = attachments?.map((attachment) => attachment.id)
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

  const value = useMemo<ActiveThreadStateValue>(
    () => ({
      activeSessionId: session.activeSessionId,
      activeThread,
      // Compatibility shim so ChatView reads `streamingStore`. There is no
      // `remoteStreamingStore` on this path (that would be Convex stream_chunks).
      activeThreadDriven: true,
      isMessagesLoading: thread?.hydration === 'loading',
      history: {
        failed: thread?.hydration === 'failed',
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
      messages: projection.messages,
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
      projection.messages,
      respond,
      retrySend,
      sendMessage,
      session.activeSessionId,
      stores,
      thread?.hydration,
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
  const thread = useActiveThread()
  const threadId = thread?.thread.threadId ?? null
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
  const { activeSessionId, openChildSession } = useContext(SessionStateContext)!
  const client = useEnvironmentClient()
  // Sidebar rows carry the workspace ID as their `path`, so the icon lookup
  // is the environment's own `workspace.icon` read. The function's identity
  // doubles as the icon cache key downstream, so it changes only when the
  // client or its advertised capabilities do; a failed lookup is a plain
  // fallback, never an error the view has to handle.
  const iconsSupported = useConnectionState().capabilities.includes('workspace.icon')
  const resolveWorkspaceIcon = useMemo(
    () =>
      iconsSupported && client.supports('resolveWorkspaceIcon')
        ? (workspaceId: string) =>
            client.commands.resolveWorkspaceIcon(workspaceId).catch(() => null)
        : undefined,
    [client, iconsSupported],
  )
  const value = useMemo<ViewActions>(
    () => ({ openChildSession, resolveWorkspaceIcon, ...actions, activeSessionId }),
    [actions, activeSessionId, openChildSession, resolveWorkspaceIcon],
  )
  return <ViewActionsContext.Provider value={value}>{children}</ViewActionsContext.Provider>
}
