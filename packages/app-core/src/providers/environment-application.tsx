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
import type {
  PlanReviewOutcome,
  ProviderId,
  QuestionOutcome,
  PermissionOption,
} from '@agentpack/contract'
import type { InteractionResponse } from '@openmanager/protocol'
import type { PendingInteraction, ThreadTarget } from '@openmanager/environment-client'
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
  useWorkspaces,
} from './environment-client'
import { PlatformCapabilitiesContext, type PlatformCapabilitiesValue } from './platform-provider'
import {
  SessionStateContext,
  type DraftRequest,
  type LocalSessionStatus,
  type SessionStateValue,
} from './session-provider'
import { ComposerStateContext, type ComposerStateValue } from './composer-provider'
import {
  SidebarDataContext,
  toggleCollapsedWorkspace,
  type SidebarDataValue,
  type SidebarSessionEntry,
} from './sidebar-provider'
import {
  ActiveThreadStateContext,
  type ActiveThreadDetails,
  type ActiveThreadStateValue,
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

const DEFAULT_PROVIDER_ID: ProviderId = 'opencode'
const COLLAPSED_WORKSPACES_KEY = 'openmanager.sidebar.collapsed-workspaces'

const EMPTY_RECORD = {}
const EMPTY_LIST: never[] = []

export interface EnvironmentApplicationOptions {
  /** How this host lets the user add a workspace; absent means it cannot. */
  addWorkspace?: () => Promise<void>
  /** Where folded sidebar rows are remembered. Defaults to `localStorage`. */
  collapsedWorkspaceStorage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Host actions for views (child sessions, icons, uploads). */
  viewActions?: Omit<ViewActions, 'activeSessionId'>
}

/**
 * Implements every application provider contract over the environment
 * client, so the shared sidebar, chat, composer and interaction panels render
 * against an environment server (or the mock) with no host-specific
 * providers at all. Composer catalogs (models, modes, config options) have no
 * protocol events yet, so that provider publishes an empty selection.
 */
export function EnvironmentApplicationProviders({
  children,
  ...options
}: EnvironmentApplicationOptions & { children: ReactNode }) {
  return (
    <EnvironmentPlatformCapabilitiesProvider>
      <EnvironmentSessionStateProvider addWorkspace={options.addWorkspace}>
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
// Platform capabilities: the environment owns providers; nothing to start here.
// ---------------------------------------------------------------------------

function EnvironmentPlatformCapabilitiesProvider({ children }: { children: ReactNode }) {
  const environment = useEnvironmentState((state) => state.environment)
  const value = useMemo<PlatformCapabilitiesValue>(
    () => ({
      providers: EMPTY_LIST,
      providerHealthByProvider: EMPTY_RECORD,
      agentUiStatusByProvider: EMPTY_RECORD,
      acpAgentInfoByProvider: EMPTY_RECORD,
      acpPromptCapabilitiesByProvider: EMPTY_RECORD,
      currentClientId: environment?.environmentId ?? null,
      error: null,
      ensureProvider: async () => true,
      retryProvider: async () => undefined,
      providerDisplayName: (providerId) => providerId,
    }),
    [environment?.environmentId],
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
  /** Create the draft's session, open it and adopt it; returns its first
   * thread, or `null` when the draft was closed or replaced meanwhile. */
  startDraftSession: () => Promise<ThreadTarget | null>
  /** The child session opened from a parent, while it is being viewed. The
   * wire has no parent link, so the relationship is remembered here. */
  childLink: { child: string; parent: string } | null
}

const DraftInternalsContext = createContext<DraftInternals | null>(null)

function EnvironmentSessionStateProvider({
  addWorkspace,
  children,
}: {
  addWorkspace?: () => Promise<void>
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
  const [childLink, setChildLink] = useState<DraftInternals['childLink']>(null)
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
      await commands.openSession(sessionId)
      if (selectionRef.current !== sessionId) client.setActiveSession(selectionRef.current)
    },
    [client, commands],
  )

  const openDraft = useCallback(
    (workspacePath: string) => {
      const previousSessionId =
        activeSession?.workspaceId === workspacePath ? activeSession.sessionId : null
      draftGenerationRef.current += 1
      selectionRef.current = null
      setChildLink(null)
      setError(null)
      setDraftWorkspaceId(workspacePath)
      setPendingDraftSessionStart(false)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      client.setActiveSession(null)
      setDraftRequest((prev) => ({
        workspacePath,
        previousSessionId,
        revision: (prev?.revision ?? 0) + 1,
      }))
    },
    [activeSession, client],
  )

  const selectSession = useCallback(
    (_workspacePath: string, externalId: string) => {
      draftGenerationRef.current += 1
      setChildLink(null)
      setError(null)
      setDraftWorkspaceId(null)
      setTurnPending(false)
      setAdoptedDraftSessionId(null)
      void openSessionLatest(externalId).catch(fail)
    },
    [fail, openSessionLatest],
  )

  const startDraftSession = useCallback(async (): Promise<ThreadTarget | null> => {
    if (!draftWorkspaceId) throw new Error('No draft is open')
    const generation = draftGenerationRef.current
    const { session, thread } = await commands.createSession({ workspaceId: draftWorkspaceId })
    if (draftGenerationRef.current !== generation) {
      // The user moved on while the session was being created: do not pull
      // the view back to it or send the prompt. The empty session goes too.
      void commands.deleteSession(session.sessionId).catch(() => undefined)
      return null
    }
    await openSessionLatest(session.sessionId)
    setAdoptedDraftSessionId(session.sessionId)
    // The session exists now; the turn that follows reads as pending until the
    // environment reports it, then the turn itself is the truth.
    setPendingDraftSessionStart(false)
    setTurnPending(true)
    setDraftWorkspaceId(null)
    return { sessionId: session.sessionId, threadId: thread.threadId }
  }, [commands, draftWorkspaceId, openSessionLatest])

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
      providerIdForSession: (_sessionId, fallback) => fallback ?? defaultProviderId,
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
      openChildSession: async (childExternalId, parentExternalId) => {
        setError(null)
        setChildLink({ child: childExternalId, parent: parentExternalId })
        await openSessionLatest(childExternalId)
      },
      closeChildSession: (parentExternalId) => {
        setChildLink(null)
        void openSessionLatest(parentExternalId).catch(fail)
      },
      createSession: async (workspacePath) => openDraft(workspacePath),
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
  const internals = useMemo<DraftInternals>(
    () => ({ startDraftSession, childLink }),
    [childLink, startDraftSession],
  )

  return (
    <SessionStateContext.Provider value={value}>
      <DraftInternalsContext.Provider value={internals}>{children}</DraftInternalsContext.Provider>
    </SessionStateContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Composer state: no catalog on the wire yet, so the selection is empty.
// ---------------------------------------------------------------------------

function EnvironmentComposerStateProvider({ children }: { children: ReactNode }) {
  const { activeSessionId, activeWorkspacePath, isSessionDraftOpen, defaultProviderId } =
    useContext(SessionStateContext)!
  const value = useMemo<ComposerStateValue>(() => {
    const noop = () => undefined
    const asyncNoop = async () => undefined
    return {
      acpSessionState: activeSessionId
        ? { sessionId: activeSessionId, providerId: defaultProviderId }
        : null,
      draftSessionState:
        isSessionDraftOpen && activeWorkspacePath
          ? { sessionId: `draft:${activeWorkspacePath}`, providerId: defaultProviderId }
          : null,
      composerConfigValues: EMPTY_RECORD,
      providerComposerProfiles: EMPTY_RECORD,
      agentEvents: EMPTY_LIST,
      error: null,
      setDraftModel: noop,
      setDraftMode: noop,
      setDraftProvider: noop,
      setDraftConfigOption: noop,
      setSessionModel: asyncNoop,
      setSessionMode: asyncNoop,
      setSessionConfigOption: asyncNoop,
      recordSessionMode: noop,
      draftLaunchPreferences: () => ({ providerId: defaultProviderId }),
      sessionLaunchPreferences: () => ({}),
    }
  }, [activeSessionId, activeWorkspacePath, defaultProviderId, isSessionDraftOpen])
  return <ComposerStateContext.Provider value={value}>{children}</ComposerStateContext.Provider>
}

// ---------------------------------------------------------------------------
// Sidebar data: the catalog, grouped; folded rows remembered in storage.
// ---------------------------------------------------------------------------

function readCollapsed(storage: EnvironmentApplicationOptions['collapsedWorkspaceStorage']) {
  try {
    const raw = storage?.getItem(COLLAPSED_WORKSPACES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
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

function EnvironmentSidebarDataProvider({
  storage: storageOption,
  children,
}: {
  storage?: EnvironmentApplicationOptions['collapsedWorkspaceStorage']
  children: ReactNode
}) {
  const session = useContext(SessionStateContext)!
  const workspaces = useWorkspaces()
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

  const workspaceEntries = useMemo(
    () => workspaces.map((workspace) => ({ path: workspace.workspaceId, name: workspace.name })),
    [workspaces],
  )
  const sessionsByWorkspace = useMemo(() => {
    const grouped: Record<string, SidebarSessionEntry[]> = {}
    for (const summary of sessions) {
      const entry: SidebarSessionEntry = {
        externalId: summary.sessionId,
        title: summary.title ?? undefined,
        status: summary.status,
        providerId: session.defaultProviderId,
        isDriven: true,
      }
      ;(grouped[summary.workspaceId] ??= []).push(entry)
    }
    return grouped
  }, [session.defaultProviderId, sessions])

  const isWorkspacesLoading =
    workspaces.length === 0 &&
    (connection.phase === 'idle' || connection.phase === 'connecting') &&
    !connection.hasConnected

  const value = useMemo<SidebarDataValue>(
    () => ({
      workspaces: workspaceEntries,
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
      deleteSession: session.deleteSession,
    }),
    [
      collapsedWorkspacePaths,
      isWorkspacesLoading,
      session.activeSessionId,
      session.activeWorkspacePath,
      session.addWorkspace,
      session.createSession,
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
  const { startDraftSession, childLink } = useContext(DraftInternalsContext)!
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
            ...(childLink?.child === activeSession.sessionId
              ? { parentExternalId: childLink.parent }
              : {}),
            isDriven: true,
          }
        : null,
    [activeSession, childLink],
  )

  const target = thread?.thread ?? null
  const targetRef = useRef(target)
  targetRef.current = target

  const { beginDraftTurn, beginSessionTurn, failTurn, isSessionDraftOpen } = session

  const sendMessage = useCallback(
    async (content: string, attachments?: UploadedImageAttachment[]) => {
      const text = content.trim()
      if (!text) return
      setError(null)
      try {
        // `turn.send` carries text only for now; refusing beats silently
        // dropping an upload the composer just confirmed.
        if (attachments?.length) {
          throw new Error('This environment cannot send image attachments yet.')
        }
        if (!targetRef.current && isSessionDraftOpen) {
          beginDraftTurn()
          const created = await startDraftSession()
          if (!created) return
          beginSessionTurn()
          await commands.sendTurn({ ...created, text })
          return
        }
        const current = targetRef.current
        if (!current) return
        beginSessionTurn()
        await commands.sendTurn({ ...current, text })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failTurn(message)
        setError(message)
        throw err
      }
    },
    [beginDraftTurn, beginSessionTurn, commands, failTurn, isSessionDraftOpen, startDraftSession],
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

  const value = useMemo<ActiveThreadStateValue>(
    () => ({
      activeSessionId: session.activeSessionId,
      activeThread,
      activeThreadDriven: true,
      isMessagesLoading: thread?.hydration === 'loading',
      messages: projection.messages,
      streamingStore: stores.streamingStore,
      messageContentStore: stores.messageContentStore,
      error,
      acknowledgeOptimisticMessage: () => undefined,
      sendMessage,
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
      sendMessage,
      session.activeSessionId,
      stores,
      thread?.hydration,
    ],
  )

  return (
    <ActiveThreadStateContext.Provider value={value}>{children}</ActiveThreadStateContext.Provider>
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
  const value = useMemo<ViewActions>(
    () => ({ openChildSession, ...actions, activeSessionId }),
    [actions, activeSessionId, openChildSession],
  )
  return <ViewActionsContext.Provider value={value}>{children}</ViewActionsContext.Provider>
}
