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
  hasDraftContent,
  selectActiveSession,
  selectActiveThread,
  selectDraftContent,
  selectDraftTarget,
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
import { EnvironmentComposerDraftProvider, sendingNewSessionDraft } from './environment-drafts'
import { EnvironmentSidebarDraftsProvider } from './environment-sidebar-drafts'
import { selectSessionsWithUnsentDraft } from '../components/sidebar/sidebar-sessions'
import {
  DraftPageContext,
  DraftPageNavigationContext,
  forgetSentDraft,
  rememberSentDraft,
  sentDraftSession,
  type DraftPageInternals,
  type DraftPageTarget,
} from './draft-pages'
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
import { TurnRecoveryContext, type TurnRecoveryValue } from './turn-recovery'
import { resendablePrompt } from '../lib/turn-notice-parts'
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
import { ViewActionsContext, WorkspaceIconContext, type ViewActions } from './view-actions'
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
  /** Routed hosts navigate first; the destination owns session hydration.
   * `null` is the new-session landing. `replace` takes the place of the
   * current history entry, for an address that leads nowhere any more. */
  navigateSession?: (sessionId: string | null, options?: { replace?: boolean }) => Promise<void>
  /**
   * Hosts with draft pages: go to a draft's own address (on the web,
   * `/drafts/<id>`). A draft gets one, in place of the blank page, with its
   * first text or image. Without it the landing keeps its draft in memory.
   */
  navigateDraft?: (draftId: string, options?: { replace?: boolean }) => Promise<void>
  /** True while the host shows a new-session page (on the web, `/` or
   * `/drafts/<id>`). With no session open there, a draft stands in the most
   * recently used project, so the composer is ready on arrival. Left false, a
   * draft opens only when asked for. */
  onLanding?: boolean
  /** On a host with draft pages, the draft the address names; null or
   * absent on the blank page. */
  landingDraftId?: string | null
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
        navigateDraft={options.navigateDraft}
        onLanding={options.onLanding ?? false}
        landingDraftId={options.landingDraftId ?? null}
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
// Session state: navigation through the client, the draft page kept here.
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

/**
 * The new-session draft a page shows. Its ids are minted when the page opens
 * blank; nothing is saved until it gets text or an image, and only then does
 * it get an address of its own (`/drafts/<id>`).
 */
interface DraftPage {
  draftId: string
  /** The id its session will get. Null while a draft opened by its address
   * is not known here yet. */
  sessionId: string | null
  /** The project picked for it. On a blank page, null follows the landing. */
  workspaceId: string | null
  /** It has had text or an image, so it has an address. */
  claimed: boolean
}

const mintPage = (workspaceId: string | null): DraftPage => ({
  draftId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  workspaceId,
  claimed: false,
})

/**
 * Navigations this provider started and that have not settled: `expected`
 * is every address they can pass through on the way, the one they started
 * from first. While the address reads one of them it is catching up, and the
 * page this provider opened stands. Any other address is the user's own move.
 */
interface RouteAhead {
  expected: Array<string | null | undefined>
}

/** A draft page retired because another device sent its draft as `sessionId`. */
interface RetiredPage {
  draftId: string
  sessionId: string
}

const selectActiveSessionId = (state: EnvironmentState) =>
  selectActiveSession(state)?.sessionId ?? null
const selectActiveSessionWorkspaceId = (state: EnvironmentState) =>
  selectActiveSession(state)?.workspaceId ?? null
const selectActiveThreadId = (state: EnvironmentState) =>
  selectActiveThread(state)?.thread.threadId ?? null
const selectDraftsListed = (state: EnvironmentState) => state.draftsListed

function EnvironmentSessionStateProvider({
  addWorkspace,
  navigateSession,
  navigateDraft,
  onLanding,
  landingDraftId,
  children,
}: {
  addWorkspace?: () => Promise<void>
  navigateSession?: EnvironmentApplicationOptions['navigateSession']
  navigateDraft?: EnvironmentApplicationOptions['navigateDraft']
  onLanding: boolean
  landingDraftId: string | null
  children: ReactNode
}) {
  const client = useEnvironmentClient()
  const { commands } = client
  const sync = client.drafts
  // Only which session is on screen, and where: its title, status or settle
  // are the sidebar's and the thread's to show, and reading the whole session
  // here would hand every reader of session state a new value on each.
  const activeSessionId = useEnvironmentState(selectActiveSessionId)
  const activeSessionWorkspaceId = useEnvironmentState(selectActiveSessionWorkspaceId)
  const activeTurn = useActiveTurn()
  const workspaces = useWorkspaces()
  const recentWorkspaces = useRecentWorkspaces()
  const connection = useConnectionState()
  const [page, setPage] = useState<DraftPage | null>(null)
  const [ahead, setAhead] = useState<RouteAhead | null>(null)
  const [retired, setRetired] = useState<RetiredPage | null>(null)
  // The retired draft's session has been on screen since.
  const retiredOpenedRef = useRef(false)
  // The retired draft's session went, and its address fell back to `/`.
  const retiredFellBackRef = useRef(false)
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
  // Drafts this page gave an address, and where they go: the address of one
  // the environment does not have (an image alone, or text since deleted)
  // still opens it, and a sent one's leads to its session.
  const claimedRef = useRef(new Map<string, { workspaceId: string | null; sessionId: string }>())
  const aheadRef = useRef<RouteAhead | null>(null)

  // The session the client has selected, whether or not its row has arrived.
  const selectedSessionId = useEnvironmentState((state) => state.activeSessionId)

  // Hosts with draft pages say which draft the address names: null for the
  // blank page, undefined off the new-session pages.
  const routed = navigateDraft !== undefined
  const routeDraft = onLanding ? (routed ? landingDraftId : null) : undefined
  const landingWorkspaceId = landingWorkspaceFor(workspaces, recentWorkspaces)
  const isListed = (workspaceId: string | null): workspaceId is string =>
    workspaceId !== null && workspaces.some((workspace) => workspace.workspaceId === workspaceId)

  // The page follows the address, worked out here rather than in an effect:
  // an effect would show the previous page for a frame, and one that
  // navigated would race the sidebar's clicks.
  let shown = page
  const strayed = ahead !== null && !ahead.expected.includes(routeDraft)
  if (strayed) {
    aheadRef.current = null
    setAhead(null)
  }
  const catchingUp = ahead !== null && !strayed
  if (!catchingUp && onLanding && selectedSessionId === null) {
    if (!routed) {
      shown ??= mintPage(null)
    } else if (routeDraft === null || routeDraft === undefined) {
      // `/` is a blank page: a draft that has been written in has its own address.
      if (!shown || shown.claimed) shown = mintPage(null)
    } else if (shown?.draftId !== routeDraft) {
      const known = claimedRef.current.get(routeDraft)
      shown = {
        draftId: routeDraft,
        sessionId: known?.sessionId ?? null,
        workspaceId: known?.workspaceId ?? null,
        claimed: true,
      }
    }
  }
  // A blank page keeps the project it was first shown in while that is
  // listed, so activity elsewhere, which reorders the recent list, does not
  // move a page the user may be about to type into. A folder that goes
  // missing keeps it too: the folder can come back.
  if (
    shown &&
    !shown.claimed &&
    activeSessionId === null &&
    !isListed(shown.workspaceId) &&
    landingWorkspaceId !== null
  ) {
    shown = { ...shown, workspaceId: landingWorkspaceId }
  }
  if (shown !== page) {
    if (shown?.draftId !== page?.draftId) draftGenerationRef.current += 1
    setPage(shown)
  }

  const pageDraftId = shown?.draftId ?? null
  const pageEnvironmentTarget = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        pageDraftId ? selectDraftTarget(state, pageDraftId) : undefined,
      [pageDraftId],
    ),
  )
  const environmentTarget =
    pageEnvironmentTarget?.type === 'new_session' ? pageEnvironmentTarget : undefined
  const pageSessionId = environmentTarget?.sessionId ?? shown?.sessionId ?? null
  const pagePending = shown !== null && pageSessionId === null
  // The page keeps the environment's latest word on where its draft goes,
  // whoever moved it, so clearing the text (which deletes the environment's
  // copy) leaves the page, its project and its session id as they were.
  if (
    shown?.claimed &&
    environmentTarget &&
    (shown.sessionId !== environmentTarget.sessionId ||
      shown.workspaceId !== environmentTarget.workspaceId)
  ) {
    const { sessionId, workspaceId } = environmentTarget
    claimedRef.current.set(shown.draftId, { workspaceId, sessionId })
    setPage({ ...shown, sessionId, workspaceId })
  }
  // The environment's copy says where a draft is; a page's own pick stands
  // for one it does not have. An unlisted project is gone: a written draft
  // stays and shows that, a blank page just opens where the landing would.
  const pickedWorkspaceId = environmentTarget
    ? environmentTarget.workspaceId
    : (shown?.workspaceId ?? null)
  // Sent elsewhere: the session minted with the draft exists, and this
  // client is not the one sending it. Typing on would revive a draft whose
  // session id is taken, so the page goes the way its address does.
  const consumedSessionId = useEnvironmentState((state) =>
    shown?.claimed &&
    pageSessionId &&
    state.sessions[pageSessionId] !== undefined &&
    !state.draftEdits[shown.draftId]?.launching
      ? pageSessionId
      : null,
  )
  const pageConsumed =
    consumedSessionId !== null && !(sync && shown && sendingNewSessionDraft(sync, shown.draftId))
  const pageUnusable = pagePending || pageConsumed
  const draftWorkspaceId = pageUnusable
    ? null
    : isListed(pickedWorkspaceId)
      ? pickedWorkspaceId
      : shown && !shown.claimed
        ? landingWorkspaceId
        : null

  const isSessionDraftOpen = activeSessionId === null && shown !== null && !pageUnusable
  const activeWorkspacePath = activeSessionWorkspaceId ?? draftWorkspaceId
  const isDraftLoading = activeSessionId === null && selectedSessionId === null && pageUnusable
  const isDraftProjectRemoved = isSessionDraftOpen && !!shown?.claimed && draftWorkspaceId === null

  // Read by callbacks that run outside render.
  const pageRef = useRef(shown)
  pageRef.current = shown
  const pageSessionIdRef = useRef(pageSessionId)
  pageSessionIdRef.current = pageSessionId
  const draftWorkspaceRef = useRef(draftWorkspaceId)
  draftWorkspaceRef.current = draftWorkspaceId
  const routeRef = useRef(routeDraft)
  routeRef.current = routeDraft

  // An address this client cannot place once the environment has listed its
  // drafts: a sent draft leads to its session, anything else to a blank page.
  // Only while that address is still on screen and nothing else was picked.
  // A sent draft's session need not be loaded: the session's address asks
  // the environment for it, and leads on to `/` if it has gone since.
  const draftsListed = useEnvironmentState(selectDraftsListed)
  const sentSessionId = pagePending && shown ? sentDraftSession(shown.draftId) : undefined
  const sentSessionKnown = useEnvironmentState((state) =>
    sentSessionId ? state.sessions[sentSessionId] !== undefined : false,
  )
  const sessionDraftOf = pageEnvironmentTarget?.type === 'session' ? pageDraftId : null
  const canList = !!sync && (connection.phase !== 'connected' || client.supports('saveDraft'))
  // Once per address: a router that settles a moment later must not be sent
  // the same way twice.
  const redirectedRef = useRef<string | null>(null)
  useEffect(() => {
    // Back at that address later, it is followed again.
    if (redirectedRef.current !== routeDraft) redirectedRef.current = null
    if (!pageUnusable || !pageDraftId || selectedSessionId !== null) return
    if (pageConsumed && consumedSessionId) rememberSentDraft(pageDraftId, consumedSessionId)
    if (!routed || !navigateSession) {
      // No address to follow: a blank page takes its place, in its project.
      if (!pageConsumed) return
      const next = mintPage(pageRef.current?.workspaceId ?? null)
      pageRef.current = next
      setPage(next)
      return
    }
    if (routeDraft !== pageDraftId) return
    const redirect = pageConsumed
      ? consumedSessionId
      : sessionDraftOf
        ? sessionDraftOf
        : sentSessionId && sentSessionKnown
          ? sentSessionId
          : draftsListed || !canList
            ? (sentSessionId ?? null)
            : undefined
    if (redirect === undefined || redirectedRef.current === pageDraftId) return
    redirectedRef.current = pageDraftId
    if (pageConsumed && consumedSessionId) {
      retiredOpenedRef.current = false
      retiredFellBackRef.current = false
      setRetired({ draftId: pageDraftId, sessionId: consumedSessionId })
    }
    void navigateSession(redirect, { replace: true }).catch(noop)
  }, [
    canList,
    consumedSessionId,
    draftsListed,
    navigateSession,
    pageConsumed,
    pageDraftId,
    pageUnusable,
    routeDraft,
    routed,
    selectedSessionId,
    sentSessionId,
    sentSessionKnown,
    sessionDraftOf,
  ])

  // A session sent from another device is announced before its provider
  // starts, and nothing says when that start is past failing. If it fails,
  // the environment deletes the session and saves the draft back, as sent:
  // the retired page then takes its address back, unless the user has moved
  // on: to another session or draft, off the session while it stood, or off
  // the `/` its address fell back to once it went. New agent and opening a
  // session are moves whenever they come (`openDraft`, `selectSession`).
  const retiredState = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) => {
        if (!retired) return null
        if (state.sessions[retired.sessionId]) return 'listed'
        const target = state.drafts[retired.draftId]?.target
        return target?.type === 'new_session' && target.sessionId === retired.sessionId
          ? 'restored'
          : 'gone'
      },
      [retired],
    ),
  )
  useEffect(() => {
    if (!retired) return
    if (selectedSessionId === retired.sessionId) retiredOpenedRef.current = true
    if (retiredState !== 'listed' && routeDraft === null) retiredFellBackRef.current = true
    const movedOn =
      (selectedSessionId !== null && selectedSessionId !== retired.sessionId) ||
      (routeDraft != null && routeDraft !== retired.draftId) ||
      (retiredOpenedRef.current && selectedSessionId === null && retiredState === 'listed') ||
      // Off the new-session pages (to Settings, say) after the fallback.
      (retiredFellBackRef.current && routeDraft === undefined && selectedSessionId === null)
    if (!movedOn && retiredState !== 'restored') return
    setRetired(null)
    if (movedOn) return
    forgetSentDraft(retired.draftId)
    if (routeDraft !== retired.draftId) {
      void navigateDraft?.(retired.draftId, { replace: true }).catch(noop)
    }
  }, [navigateDraft, retired, retiredState, routeDraft, selectedSessionId])

  /**
   * Navigate, holding the page this provider opened until every navigation
   * it started has settled: the address passes through each of them on the
   * way, and none of those is a move of the user's.
   */
  const followNavigation = useCallback((to: string | null, navigation: () => Promise<unknown>) => {
    const next: RouteAhead = {
      expected: [...(aheadRef.current?.expected ?? [routeRef.current]), to],
    }
    aheadRef.current = next
    setAhead(next)
    return navigation().finally(() => {
      if (aheadRef.current !== next) return
      aheadRef.current = null
      setAhead(null)
    })
  }, [])

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
    async (sessionId: string, options?: { replace?: boolean }) => {
      selectionRef.current = sessionId
      if (navigateSession) {
        await navigateSession(sessionId, options)
        return
      }
      await commands.openSession(sessionId)
      if (selectionRef.current !== sessionId) client.setActiveSession(selectionRef.current)
    },
    [client, commands, navigateSession],
  )

  const claim = useCallback(
    (draftId: string) => {
      const current = pageRef.current
      if (!current || current.draftId !== draftId || current.claimed) return
      const workspaceId = draftWorkspaceRef.current
      const sessionId = pageSessionIdRef.current
      if (!workspaceId || !sessionId) return
      const claimed: DraftPage = { ...current, sessionId, workspaceId, claimed: true }
      pageRef.current = claimed
      claimedRef.current.set(draftId, { workspaceId, sessionId })
      setPage(claimed)
      if (!navigateDraft) return
      // Replaced, not pushed: the blank page it was is gone, not a step back.
      void followNavigation(draftId, () => navigateDraft(draftId, { replace: true })).catch(noop)
    },
    [followNavigation, navigateDraft],
  )

  const pageTarget = useCallback((draftId: string): DraftPageTarget | undefined => {
    const current = pageRef.current
    const sessionId = pageSessionIdRef.current
    if (current?.draftId === draftId && sessionId) {
      return { type: 'new_session', workspaceId: draftWorkspaceRef.current, sessionId }
    }
    const known = claimedRef.current.get(draftId)
    return known ? { type: 'new_session', ...known } : undefined
  }, [])

  const setDraftWorkspace = useCallback(
    (workspaceId: string) => {
      const current = pageRef.current
      const sessionId = pageSessionIdRef.current
      if (!current || !sessionId) return
      setError(null)
      // The draft keeps its text, images and picks; only its project changes.
      // Picks that were seeded follow the new project, because they are
      // worked out from its last-used preference whenever the draft is shown.
      const state = client.getState()
      const target = selectDraftTarget(state, current.draftId)
      const content = selectDraftContent(state, current.draftId)
      if (sync && target?.type === 'new_session' && content && target.workspaceId !== workspaceId) {
        sync.edit(current.draftId, { ...target, workspaceId }, content)
      }
      if (current.claimed) claimedRef.current.set(current.draftId, { workspaceId, sessionId })
      const moved = { ...current, sessionId, workspaceId }
      pageRef.current = moved
      setPage(moved)
    },
    [client, sync],
  )

  // A blank page is never saved, so a fresh one leaves nothing behind when
  // the open one is still empty. One that was written in stays a draft,
  // reachable by its address. Emptied again but holding picks, it would
  // linger as a draft nobody sees, so it goes when the page is left. One
  // being sent is the send's, picks and all, whatever the composer shows.
  const dropEmptiedPage = useCallback(() => {
    const current = pageRef.current
    if (!sync || !current?.claimed || sendingNewSessionDraft(sync, current.draftId)) return
    const state = client.getState()
    const content = selectDraftContent(state, current.draftId)
    const sending = state.draftEdits[current.draftId]?.launching
    if (content && !hasDraftContent(content) && !sending) sync.discard(current.draftId)
  }, [client, sync])

  const openDraft = useCallback(
    async (workspacePath: string, options?: { replace?: boolean }) => {
      const previousSessionId = activeSessionWorkspaceId === workspacePath ? activeSessionId : null
      draftGenerationRef.current += 1
      selectionRef.current = null
      setError(null)
      dropEmptiedPage()
      const next = mintPage(workspacePath)
      pageRef.current = next
      setPage(next)
      // The user's own move: a draft sent elsewhere that comes back does not
      // take this page.
      setRetired(null)
      setPendingDraftSessionStart(false)
      setLaunchingMessage(null)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      const generation = draftGenerationRef.current
      if (navigateSession) {
        await (routed
          ? followNavigation(null, () => navigateSession(null, options))
          : navigateSession(null, options))
      }
      // A later selection or draft landed while the navigation settled.
      if (draftGenerationRef.current !== generation) return
      client.setActiveSession(null)
      setDraftRequest((prev) => ({
        workspacePath,
        previousSessionId,
        revision: (prev?.revision ?? 0) + 1,
      }))
    },
    [
      activeSessionId,
      activeSessionWorkspaceId,
      client,
      dropEmptiedPage,
      followNavigation,
      navigateSession,
      routed,
    ],
  )
  const openDraftRef = useRef(openDraft)
  openDraftRef.current = openDraft
  const landingWorkspaceRef = useRef(landingWorkspaceId)
  landingWorkspaceRef.current = landingWorkspaceId
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  const onScreenDraftRef = useRef<string | null>(null)
  onScreenDraftRef.current = isSessionDraftOpen ? pageDraftId : null

  // The sidebar's draft cards: a draft's own page, by its address. A launch
  // still in flight continues in the sidebar, as when a session is picked.
  const openDraftPage = useCallback(
    (draftId: string) => {
      if (!navigateDraft || onScreenDraftRef.current === draftId) return
      draftGenerationRef.current += 1
      selectionRef.current = null
      setError(null)
      dropEmptiedPage()
      setPendingDraftSessionStart(false)
      setLaunchingMessage(null)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      void navigateDraft(draftId).catch(noop)
    },
    [dropEmptiedPage, navigateDraft],
  )

  // A discarded draft on screen leaves for a blank page in its project (or
  // where the landing opens, if its project is gone). The blank page is
  // pushed, not put in the draft's place: Back returns to the draft while its
  // undo is open, which calls the discard off.
  const closeDraftPage = useCallback(
    (draftId: string) => {
      if (onScreenDraftRef.current !== draftId) return
      const own = draftWorkspaceRef.current
      const blank = canHostDraft(workspacesRef.current.find((ws) => ws.workspaceId === own))
        ? own
        : landingWorkspaceRef.current
      if (blank) void openDraftRef.current(blank).catch(noop)
      else void navigateSession?.(null).catch(noop)
    },
    [navigateSession],
  )
  const pageNavigation = useMemo(
    () => (sync && navigateDraft ? { openDraftPage, closeDraftPage } : null),
    [closeDraftPage, navigateDraft, openDraftPage, sync],
  )

  const selectSession = useCallback(
    (_workspacePath: string, externalId: string) => {
      draftGenerationRef.current += 1
      setError(null)
      pageRef.current = null
      setPage(null)
      aheadRef.current = null
      setAhead(null)
      // Another session is the user's own move, as New agent is.
      setRetired((prev) => (prev && prev.sessionId !== externalId ? null : prev))
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
      // The project the draft was sent from: a page switched while its
      // images uploaded does not move the send.
      const workspaceId = launch.workspaceId !== undefined ? launch.workspaceId : draftWorkspaceId
      if (!workspaceId) throw new Error('Pick a project for this draft to start it.')
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
          workspaceId,
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
      const { session, thread } = created
      if (draft) {
        client.drafts?.endLaunch(draft.draftId, 'sent')
        claimedRef.current.delete(draft.draftId)
        rememberSentDraft(draft.draftId, session.sessionId)
      }
      // The user moved on, while its images uploaded or the session was
      // being created: do not pull the view back to it, nor take the page
      // that is open now. Its first turn continues in the sidebar.
      const open = pageRef.current
      if (draftGenerationRef.current !== generation || (draft && open?.draftId !== draft.draftId)) {
        // The send that held the composer was this one, unless the page open
        // now is being sent itself.
        const sendingOpen =
          open && client.drafts && sendingNewSessionDraft(client.drafts, open.draftId)
        if (!sendingOpen) setPendingDraftSessionStart(false)
        return null
      }
      // The client already holds the session, its thread and the first
      // message, so it goes on screen now, in one step. Waiting for the route
      // (and the session.open it triggers) left a gap where neither the draft
      // nor the session was showing, and the landing came back.
      selectionRef.current = session.sessionId
      client.setActiveSession(session.sessionId)
      setAdoptedDraftSessionId(session.sessionId)
      setPendingDraftSessionStart(false)
      pageRef.current = null
      setPage(null)
      aheadRef.current = null
      setAhead(null)
      // Creation already returned the first turn; its state now drives the composer.
      setTurnPending(false)
      // A sent draft's address leads nowhere now, so the session takes its
      // place in the history rather than following it.
      const navigation = routed ? { replace: true } : undefined
      // The session's own copy of the message came with it, so the echo goes in
      // the same step. Without one (an environment that leaves the first turn
      // out of its reply) the echo stays until the session's history has it.
      if (created.firstTurn) {
        setLaunchingMessage(null)
        await openSessionLatest(session.sessionId, navigation)
      } else {
        try {
          await openSessionLatest(session.sessionId, navigation)
        } finally {
          setLaunchingMessage(null)
        }
      }
      return { sessionId: session.sessionId, threadId: thread.threadId }
    },
    [client, commands, draftWorkspaceId, openSessionLatest, routed],
  )

  // The commands the sidebar and the palette call stay the same functions
  // while the state beside them changes (a launch, a pending turn, an error):
  // the sidebar data is built from them, and a new value would re-render every
  // reader of it, the whole session list included, in the middle of a send.
  const addWorkspaceCommand = useCallback(async () => {
    setError(null)
    if (!addWorkspace) {
      setError('This host cannot add workspaces.')
      return
    }
    await addWorkspace().catch(fail)
  }, [addWorkspace, fail])
  // A draft in the removed project stays open: one that was written in
  // shows its project as gone so another can be picked, and a blank page
  // moves to where the landing would open.
  const removeWorkspace = useCallback(
    async (path: string) => {
      setError(null)
      await commands.removeWorkspace(path).catch(fail)
    },
    [commands, fail],
  )
  const createSession = useCallback(
    async (workspacePath: string) => openDraftRef.current(workspacePath),
    [],
  )
  const renameSession = useCallback(
    async (_workspacePath: string, externalId: string, title: string | null) => {
      setError(null)
      await commands.renameSession(externalId, title).catch(fail)
    },
    [commands, fail],
  )
  const regenerateSessionTitle = useCallback(
    async (externalId: string) => {
      setError(null)
      await commands.regenerateSessionTitle(externalId).catch(fail)
    },
    [commands, fail],
  )
  const deleteSession = useCallback(
    async (_workspacePath: string, externalId: string) => {
      setError(null)
      await commands.deleteSession(externalId).catch(fail)
    },
    [commands, fail],
  )

  const value = useMemo<SessionStateValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      // Only where the environment keeps drafts: elsewhere the composer keeps
      // one draft per project, in this browser.
      newSessionDraftId: sync && isSessionDraftOpen ? pageDraftId : null,
      isDraftLoading,
      isDraftProjectRemoved,
      ...(sync ? { setDraftWorkspace } : {}),
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
      addWorkspace: addWorkspaceCommand,
      removeWorkspace,
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
      createSession,
      renameSession,
      regenerateSessionTitle,
      deleteSession,
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
      addWorkspaceCommand,
      adoptedDraftSessionId,
      client,
      createSession,
      defaultProviderId,
      deleteSession,
      draftRequest,
      error,
      fail,
      isDraftLoading,
      isDraftProjectRemoved,
      isSessionDraftOpen,
      launchingMessage,
      localSessionStatus,
      openSessionLatest,
      pageDraftId,
      pendingDraftSessionStart,
      regenerateSessionTitle,
      removeWorkspace,
      renameSession,
      selectSession,
      setDraftWorkspace,
      sync,
    ],
  )
  const internals = useMemo<DraftInternals>(() => ({ startDraftSession }), [startDraftSession])
  const pageInternals = useMemo<DraftPageInternals>(
    () => ({ pageDraftId: isSessionDraftOpen ? pageDraftId : null, pageTarget, claim }),
    [claim, isSessionDraftOpen, pageDraftId, pageTarget],
  )

  return (
    <SessionStateContext.Provider value={value}>
      <DraftInternalsContext.Provider value={internals}>
        <DraftPageContext.Provider value={pageInternals}>
          <DraftPageNavigationContext.Provider value={pageNavigation}>
            {children}
          </DraftPageNavigationContext.Provider>
        </DraftPageContext.Provider>
      </DraftInternalsContext.Provider>
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
  // Which sessions hold an unsent draft: a coarse fact, so typing in a
  // composer changes it only when the text empties or starts.
  const syncsDrafts = client.drafts !== undefined
  const openSessionId = session.activeSessionId
  const unsent = useEnvironmentState(
    useMemo(() => {
      if (!syncsDrafts) return () => EMPTY_LIST
      // Read again only when a draft changed, not on every streamed token.
      let last: { drafts: unknown; edits: unknown; ids: string[] } | undefined
      return (state: EnvironmentState) => {
        if (last && last.drafts === state.drafts && last.edits === state.draftEdits) return last.ids
        const ids = selectSessionsWithUnsentDraft(state, openSessionId)
        last = { drafts: state.drafts, edits: state.draftEdits, ids }
        return ids
      }
    }, [openSessionId, syncsDrafts]),
    shallowEqualArray,
  )
  // What the sidebar was last handed, so an unchanged row stays the same object.
  const shownSessions = useRef<SidebarSessionsByWorkspace | null>(null)
  const sessionsByWorkspace = useMemo(() => {
    const unsentIds = new Set(unsent)
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
        ...(unsentIds.has(summary.sessionId) ? { hasUnsentDraft: true } : {}),
      }
      ;(grouped[summary.workspaceId] ??= []).push(entry)
    }
    shownSessions.current = reuseUnchanged(shownSessions.current, grouped)
    return shownSessions.current
  }, [session.defaultProviderId, sessions, unsent, workspaceEntries])

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
        <EnvironmentSidebarDraftsProvider>{children}</EnvironmentSidebarDraftsProvider>
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
          const launchWorkspaceId =
            launch.workspaceId !== undefined ? launch.workspaceId : activeWorkspacePath
          if (!(await ensureProvider(launch.providerId, launchWorkspaceId ?? ''))) {
            throw new Error(
              `${providerDisplayName(launch.providerId)} is unavailable. Retry it from Settings.`,
            )
          }
          await startDraftSession(text, launch, artifactIds)
          draftLaunched(launch)
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

  // What a failed turn's row offers. A retry is a new turn with the failed
  // turn's prompt and images; compacting is Claude Code's own `/compact`,
  // sent as the composer sends any command. Neither may race a send that is
  // still on its way: the environment would refuse the second, and that
  // refusal would clear the composer's pending state for the first.
  const recoveryBusy = !!activeTurn || session.localSessionStatus !== null
  const recoveryBusyRef = useRef(recoveryBusy)
  recoveryBusyRef.current = recoveryBusy
  const resend = useCallback(
    async (text: string, artifactIds: string[] = []) => {
      const current = targetRef.current
      if (!current || recoveryBusyRef.current) return
      recoveryBusyRef.current = true
      setError(null)
      beginSessionTurn()
      await commands
        .sendTurn({ ...current, text, ...(artifactIds.length ? { artifactIds } : {}) })
        .catch(() => failTurn())
    },
    [beginSessionTurn, commands, failTurn],
  )
  const retryTurn = useCallback(
    async (turnId: string) => {
      const current = targetRef.current
      if (!current) return
      // The row only offers Retry when this prompt is loaded; see the projection.
      const prompt = resendablePrompt(
        client.getState().threads[current.threadId]?.messages ?? [],
        turnId,
      )
      if (prompt) await resend(prompt.text, prompt.artifactIds)
    },
    [client, resend],
  )
  const compactSession = useCallback(() => resend('/compact'), [resend])
  const activeProviderId = activeSession?.providerId
  const recovery = useMemo<TurnRecoveryValue>(
    () => ({
      retry: retryTurn,
      compact: compactSession,
      ...(activeProviderId && isProviderId(activeProviderId)
        ? { providerName: providerDisplayName(activeProviderId) }
        : {}),
      busy: recoveryBusy,
    }),
    [activeProviderId, compactSession, providerDisplayName, recoveryBusy, retryTurn],
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
        <TurnRecoveryContext.Provider value={recovery}>{children}</TurnRecoveryContext.Provider>
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
  // Icons get the lookup on its own (`WorkspaceIconContext`); a host's own
  // `resolveWorkspaceIcon` in `actions` still wins, as it does in `value`.
  const iconLookup =
    (actions && 'resolveWorkspaceIcon' in actions
      ? actions.resolveWorkspaceIcon
      : resolveWorkspaceIcon) ?? null
  return (
    <ViewActionsContext.Provider value={value}>
      <WorkspaceIconContext.Provider value={iconLookup}>{children}</WorkspaceIconContext.Provider>
    </ViewActionsContext.Provider>
  )
}
