import type { AgentEvent, ProviderId } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import type { FunctionReference } from 'convex/server'
import {
  applyActiveSession,
  applyActiveThread,
  applyConnection,
  applyEnvironment,
  applyEvent,
  applySessionCreated,
  applySessionList,
  applySessionOpen,
  applySessionRemoved,
  applySessionTitle,
  applyThreadHydration,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  createEnvironmentStore,
  deriveSessionStatus,
  EnvironmentClientError,
  selectSessionList,
  WIRE_COMMANDS,
  type EnvironmentClient,
  type EnvironmentCommands,
  type EnvironmentState,
  type ThreadState,
} from '@openmanager/environment-client'
import type {
  ContentBlock,
  Environment,
  Interaction,
  Message,
  ProofEvent,
  ProofResponse,
  Session,
  Thread,
  Turn,
  Workspace,
} from '@openmanager/protocol'
import { createAgentEventTranslator } from './agent-event-translator'

/**
 * TEMPORARY — deleted with Convex retirement (see docs/compatibility-adapters.md).
 *
 * An `EnvironmentClient` for the desktop renderer during migration. Reads
 * come from the existing Convex deployment, live turn state from the Electron
 * IPC channels the main process already pushes (`acp:event`, `stream:token`),
 * and every write is a `pending_jobs` row that this desktop's `JobWorker`
 * claims — exactly the paths the legacy domain providers use, so the app keeps
 * working while views move over to the shared environment-client hooks.
 *
 * Nothing here is imported by visual components. The renderer mounts it
 * through `DesktopEnvironmentClientProvider`, behind the backend flag.
 */

/** The three Convex operations the adapter needs, so tests can fake the deployment. */
export interface ConvexGateway {
  query<T = unknown>(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
  ): Promise<T>
  mutation<T = unknown>(
    reference: FunctionReference<'mutation'>,
    args: Record<string, unknown>,
  ): Promise<T>
  /** Reactive query; `onUpdate` fires with every loaded result until unsubscribed. */
  subscribe<T = unknown>(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
    onUpdate: (value: T) => void,
  ): () => void
}

/** The slice of the preload bridge the adapter uses. `window.electronAPI` satisfies it. */
export interface DesktopEventBridge {
  onAcpEvent(callback: (event: AgentEvent) => void): () => void
  onStreamToken(callback: (event: AgentEvent) => void): () => void
  getLastProviderId(): Promise<ProviderId>
}

export interface ConvexEnvironmentClientOptions {
  convex: ConvexGateway
  bridge: DesktopEventBridge
  /** This desktop's client identity; jobs are targeted at it. */
  clientId: string
  environmentId?: string
  /** How long a job may take to produce its lifecycle event before the command rejects. */
  jobTimeoutMs?: number
}

const ALL_CAPABILITIES = Object.values(WIRE_COMMANDS)
const SEEN_EVENT_LIMIT = 4096
const INTERRUPTED_FINISH = /cancel|abort|interrupt/i
const FAILED_FINISH = /error|fail/i

type WorkspaceRow = { _id: string; path: string; name: string }
type SidebarRow = {
  workspacePath: string
  externalId: string
  title?: string
  status: string
  providerId?: string
  parentExternalId?: string
}
type SessionRow = {
  externalId: string
  workspaceId: string
  title?: string
  status: string
  providerId?: string
  parentExternalId?: string
}
type MessageMetadataRow = {
  externalId: string
  role: string
  sequenceNum: number
  isFinal?: boolean
}
type MessageContentRow = {
  externalId: string
  content: string
  role: string
  isFinal?: boolean
  metadata?: {
    parts?: Array<Record<string, unknown>>
    runtime?: { finishReason?: string }
  }
}
type PendingPermissionRow = {
  requestId: string
  toolCallId?: string
  permission?: string
  toolName: string
  description: string
  options?: Extract<Interaction, { kind: 'permission' }>['options']
  expiresAt?: number
}
type PendingQuestionRow = {
  requestId: string
  title?: string
  questions: Extract<Interaction, { kind: 'question' }>['questions']
}
type PendingPlanRow = {
  requestId: string
  name?: string
  overview?: string
  markdown: string
  todos: Extract<Interaction, { kind: 'plan' }>['todos']
  phases?: Extract<Interaction, { kind: 'plan' }>['phases']
}
type JobStatusRow = { status: string; lastError?: string } | null

type SessionOpenPayload = ProofResponse<'session.open'>['payload']

type Waiter<T> = { resolve: (value: T) => void; reject: (error: Error) => void }

const isProvider = (value: unknown): value is ProviderId => typeof value === 'string'

export function createConvexEnvironmentClient(
  options: ConvexEnvironmentClientOptions,
): EnvironmentClient {
  const { convex, bridge, clientId } = options
  const environmentId = options.environmentId ?? `desktop:${clientId}`
  const jobTimeoutMs = options.jobTimeoutMs ?? 60_000
  const environment: Environment = { environmentId, name: 'Desktop (Convex)' }
  const translator = createAgentEventTranslator({ environmentId })
  const store = createEnvironmentStore()

  let connected = false
  let disposed = false
  let unsubscribeBridge: Array<() => void> = []
  let unsubscribeWorkspaces: (() => void) | null = null
  let unsubscribeSessions: (() => void) | null = null
  let subscribedWorkspaceKey = ''
  /** Sessions the Convex sidebar list has reported; only these are removed when the list drops them. */
  const convexSessions = new Set<string>()
  const providerBySession = new Map<string, ProviderId>()
  const seenEvents = new Set<string>()
  /** At most one per workspace; see `serializeCreation`. */
  const sessionWaiters = new Map<string, Waiter<string>>()
  const turnWaiters = new Map<string, Waiter<{ turn: Turn; userMessage: Message }>>()

  const update = (reducer: (state: EnvironmentState) => EnvironmentState) => store.update(reducer)

  // -------------------------------------------------------------------------
  // Live events over IPC
  // -------------------------------------------------------------------------

  /**
   * The main process sends stream/tool/turn events on both channels. Keeping
   * both subscriptions makes the adapter indifferent to which channel a given
   * event class ends up on; the ID set makes the duplicate a no-op.
   */
  const remember = (eventId: string) => {
    if (seenEvents.has(eventId)) return false
    seenEvents.add(eventId)
    if (seenEvents.size > SEEN_EVENT_LIMIT) {
      const oldest = seenEvents.values().next().value
      if (oldest !== undefined) seenEvents.delete(oldest)
    }
    return true
  }

  const ingest = (event: AgentEvent) => {
    if (disposed || !remember(event.id)) return
    const events = translator.translate(event)
    update((state) => {
      let next = state
      for (const proof of events) {
        // Convex is the catalog of record; a `session_created` echo for a
        // session the list already knows must not reset its title.
        if (proof.name === 'session.created' && next.sessions[proof.payload.session.sessionId]) {
          continue
        }
        next = applyEvent(next, proof)
      }
      return next
    })
    settleWaiters(event, events)
  }

  const settleWaiters = (event: AgentEvent, events: ProofEvent[]) => {
    if (event.event === 'session_created' && event.workspaceId) {
      const waiter = sessionWaiters.get(event.workspaceId)
      if (waiter) {
        sessionWaiters.delete(event.workspaceId)
        waiter.resolve(event.sessionId)
      }
    }
    if (event.event === 'prompt_started') {
      const waiter = turnWaiters.get(event.data.userMessageId)
      const started = events.find((proof) => proof.name === 'turn.started')
      if (waiter && started?.name === 'turn.started') {
        turnWaiters.delete(event.data.userMessageId)
        waiter.resolve(started.payload)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Convex catalog subscriptions
  // -------------------------------------------------------------------------

  const toWorkspace = (row: WorkspaceRow): Workspace => ({ workspaceId: row.path, name: row.name })
  const toSession = (
    row: { externalId: string; title?: string },
    workspaceId: string,
  ): Session => ({
    sessionId: row.externalId,
    workspaceId,
    title: row.title ?? null,
  })
  const threadOf = (sessionId: string): Thread => ({ threadId: sessionId, sessionId })

  /** Ensures a thread exists for a session, the way `thread.created` would on the wire. */
  const knownThread = (state: EnvironmentState, sessionId: string): EnvironmentState =>
    applyEvent(state, {
      type: 'event',
      eventId: `catalog:${sessionId}`,
      timestamp: new Date(0).toISOString(),
      name: 'thread.created',
      scope: { type: 'session', environmentId, sessionId },
      payload: { thread: threadOf(sessionId) },
    })

  const syncWorkspaces = (rows: WorkspaceRow[] | null | undefined) => {
    if (!rows) return
    const workspaces = rows.map(toWorkspace)
    const paths = new Set(workspaces.map((workspace) => workspace.workspaceId))
    update((state) => {
      let next = applyWorkspaceList(state, workspaces)
      for (const id of state.workspaceOrder) {
        if (!paths.has(id)) next = applyWorkspaceRemoved(next, id)
      }
      return next
    })
    subscribeSessions([...paths].sort())
  }

  const subscribeSessions = (workspacePaths: string[]) => {
    const key = workspacePaths.join('\n')
    if (key === subscribedWorkspaceKey) return
    subscribedWorkspaceKey = key
    unsubscribeSessions?.()
    unsubscribeSessions = null
    if (workspacePaths.length === 0) {
      syncSessions([])
      return
    }
    unsubscribeSessions = convex.subscribe<SidebarRow[]>(
      api.sessions.listForSidebar,
      { workspacePaths },
      syncSessions,
    )
  }

  const syncSessions = (rows: SidebarRow[] | null | undefined) => {
    if (!rows) return
    // Subagent transcripts (child sessions) stay hidden, as in the sidebar.
    const visible = rows.filter((row) => !row.parentExternalId)
    for (const row of visible) {
      if (isProvider(row.providerId)) providerBySession.set(row.externalId, row.providerId)
    }
    const ids = new Set(visible.map((row) => row.externalId))
    update((state) => {
      let next = applySessionList(
        state,
        visible.map((row) => toSession(row, row.workspacePath)),
      )
      for (const row of visible) next = knownThread(next, row.externalId)
      for (const sessionId of convexSessions) {
        if (!ids.has(sessionId)) next = applySessionRemoved(next, sessionId)
      }
      return next
    })
    convexSessions.clear()
    for (const id of ids) convexSessions.add(id)
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  const requireSession = (sessionId: string) => {
    const session = store.getState().sessions[sessionId]
    if (!session) throw new EnvironmentClientError('not_found', 'Session not found.')
    return session
  }

  const providerFor = (sessionId: string): ProviderId =>
    providerBySession.get(sessionId) ?? 'opencode'

  const submitJob = (
    workspacePath: string,
    type: string,
    payload: Record<string, unknown>,
    sessionExternalId?: string,
  ) =>
    convex.mutation<string>(api.jobs.submit, {
      workspacePath,
      type,
      payload: JSON.stringify({ workspacePath, ...payload }),
      clientId,
      ...(sessionExternalId ? { sessionExternalId } : {}),
    })

  /**
   * A job's terminal status. `done` settles with the worker's outcome so a
   * command can report a failure instead of waiting for a lifecycle event
   * that will never come; `failed` only ever rejects, for racing against a
   * lifecycle event that arrives long before the job itself finishes.
   */
  const watchJob = (jobId: string) => {
    let stop: (() => void) | null = null
    const done = new Promise<void>((resolve, reject) => {
      stop = convex.subscribe<JobStatusRow>(api.jobs.getStatus, { jobId }, (job) => {
        if (job?.status === 'done') resolve()
        if (job?.status === 'failed') {
          reject(new EnvironmentClientError('internal', job.lastError ?? 'The job failed.'))
        }
      })
    })
    const failed = new Promise<never>((_, reject) => done.catch(reject))
    failed.catch(() => undefined)
    return { done, failed, stop: () => stop?.() }
  }

  /**
   * One session creation at a time per workspace. `session_created` carries
   * no job identity, only the workspace, so two creations in flight for the
   * same workspace could otherwise adopt each other's IDs.
   */
  const creationChains = new Map<string, Promise<unknown>>()
  const serializeCreation = <T>(workspacePath: string, work: () => Promise<T>): Promise<T> => {
    const previous = creationChains.get(workspacePath) ?? Promise.resolve()
    const run = previous.then(work, work)
    const chain = run.then(
      () => undefined,
      () => undefined,
    )
    creationChains.set(workspacePath, chain)
    void chain.then(() => {
      if (creationChains.get(workspacePath) === chain) creationChains.delete(workspacePath)
    })
    return run
  }

  const withTimeout = <T>(promise: Promise<T>, what: string) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EnvironmentClientError('unavailable', `Timed out waiting for ${what}.`)),
        jobTimeoutMs,
      )
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  const awaitSessionCreated = (workspacePath: string) => {
    const promise = new Promise<string>((resolve, reject) => {
      sessionWaiters.set(workspacePath, { resolve, reject })
    })
    return { promise, cancel: () => sessionWaiters.delete(workspacePath) }
  }

  const awaitTurnStarted = (userMessageId: string) => {
    const promise = new Promise<{ turn: Turn; userMessage: Message }>((resolve, reject) => {
      turnWaiters.set(userMessageId, { resolve, reject })
    })
    return { promise, cancel: () => turnWaiters.delete(userMessageId) }
  }

  const rejectWaiters = (error: Error) => {
    for (const waiter of sessionWaiters.values()) waiter.reject(error)
    sessionWaiters.clear()
    for (const waiter of turnWaiters.values()) waiter.reject(error)
    turnWaiters.clear()
  }

  // -------------------------------------------------------------------------
  // Hydration
  // -------------------------------------------------------------------------

  const contentBlocks = (row: MessageContentRow): ContentBlock[] => {
    const blocks: ContentBlock[] = row.content ? [{ type: 'text', text: row.content }] : []
    for (const part of row.metadata?.parts ?? []) {
      if (part.type !== 'image' || typeof part.url !== 'string') continue
      blocks.push({
        type: 'resource_link',
        uri: part.url,
        ...(typeof part.name === 'string' ? { name: part.name } : {}),
        ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}),
      })
    }
    return blocks
  }

  const assistantTurnState = (row: MessageContentRow, sessionRunning: boolean): Turn['state'] => {
    const finish = row.metadata?.runtime?.finishReason ?? ''
    if (!row.isFinal) return sessionRunning ? 'running' : 'interrupted'
    if (FAILED_FINISH.test(finish)) return 'failed'
    if (INTERRUPTED_FINISH.test(finish)) return 'interrupted'
    return 'completed'
  }

  /**
   * Rebuild turns from the persisted message list: each assistant message is
   * a turn (its external ID is the turn ID the live stream uses), and the user
   * messages before it belong to it. A trailing user message with no reply
   * yet is the turn in flight when the session says it is running.
   */
  const buildThread = (
    sessionId: string,
    rows: MessageContentRow[],
    sessionRunning: boolean,
  ): { messages: Message[]; turns: Turn[] } => {
    const messages: Message[] = []
    const turns: Turn[] = []
    let pendingUsers: Message[] = []
    for (const row of rows) {
      if (row.role === 'assistant') {
        const turnId = row.externalId
        for (const user of pendingUsers) messages.push({ ...user, turnId })
        pendingUsers = []
        turns.push({ turnId, threadId: sessionId, state: assistantTurnState(row, sessionRunning) })
        messages.push({
          messageId: row.externalId,
          threadId: sessionId,
          turnId,
          role: 'assistant',
          content: contentBlocks(row),
        })
      } else if (row.role === 'user') {
        pendingUsers.push({
          messageId: row.externalId,
          threadId: sessionId,
          turnId: row.externalId,
          role: 'user',
          content: contentBlocks(row),
        })
      }
    }
    if (pendingUsers.length) {
      const last = pendingUsers.at(-1)!
      for (const user of pendingUsers) messages.push({ ...user, turnId: last.messageId })
      if (sessionRunning)
        turns.push({ turnId: last.messageId, threadId: sessionId, state: 'running' })
    }
    return { messages, turns }
  }

  const pendingInteractions = (
    permission: PendingPermissionRow | null,
    question: PendingQuestionRow | null,
    plan: PendingPlanRow | null,
  ): Interaction[] => {
    const interactions: Interaction[] = []
    if (permission) {
      interactions.push({
        kind: 'permission',
        interactionId: permission.requestId,
        toolCall: {
          toolCallId: permission.toolCallId ?? permission.requestId,
          title: permission.toolName,
          ...(permission.permission ? { kind: permission.permission } : {}),
        },
        // Rows written before options were persisted still need an answer.
        options: permission.options?.length
          ? permission.options
          : [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
        ...(permission.expiresAt
          ? { expiresAt: new Date(permission.expiresAt).toISOString() }
          : {}),
      })
    }
    if (question) {
      interactions.push({
        kind: 'question',
        interactionId: question.requestId,
        ...(question.title !== undefined ? { title: question.title } : {}),
        questions: question.questions,
      })
    }
    if (plan) {
      interactions.push({
        kind: 'plan',
        interactionId: plan.requestId,
        ...(plan.name !== undefined ? { name: plan.name } : {}),
        ...(plan.overview !== undefined ? { overview: plan.overview } : {}),
        markdown: plan.markdown,
        todos: plan.todos,
        ...(plan.phases ? { phases: plan.phases } : {}),
        // Convex never persisted the continuation; the job worker reads the
        // live plan document when the answer is built, so this is display-only.
        continuation: 'follow_up_turn',
      })
    }
    return interactions
  }

  const loadSession = async (
    sessionId: string,
    workspaceId: string,
  ): Promise<SessionOpenPayload> => {
    const [row, metadata, permission, question, plan] = await Promise.all([
      convex.query<SessionRow | null>(api.sessions.getByExternalId, { externalId: sessionId }),
      convex.query<MessageMetadataRow[]>(api.messages.listMetadata, {
        sessionExternalId: sessionId,
      }),
      convex.query<PendingPermissionRow | null>(api.permissions.getPendingForSession, {
        sessionExternalId: sessionId,
      }),
      convex.query<PendingQuestionRow | null>(api.questions.getPendingForSession, {
        sessionExternalId: sessionId,
      }),
      convex.query<PendingPlanRow | null>(api.plans.getPendingForSession, {
        sessionExternalId: sessionId,
      }),
    ])
    if (!row) throw new EnvironmentClientError('not_found', 'Session not found.')
    if (isProvider(row.providerId)) providerBySession.set(sessionId, row.providerId)
    const ordered = [...metadata]
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .sort((left, right) => left.sequenceNum - right.sequenceNum)
    const contents = await Promise.all(
      ordered.map((item) =>
        convex.query<MessageContentRow | null>(api.messages.getContent, {
          externalId: item.externalId,
        }),
      ),
    )
    const rows = contents.filter((item): item is MessageContentRow => item !== null)
    // The projector writes `waiting` while a permission/question/plan is
    // pending; the turn is just as open then as when it is `running`.
    const active = row.status === 'running' || row.status === 'waiting'
    const { messages, turns } = buildThread(sessionId, rows, active)
    const interactions = pendingInteractions(permission, question, plan)
    // A pending interaction is what makes a turn `waiting` on the wire; the
    // Convex rows only imply it.
    const open = interactions.length ? turns.find((turn) => turn.state === 'running') : undefined
    if (open) open.state = 'waiting'
    return {
      session: toSession(row, workspaceId),
      threads: [threadOf(sessionId)],
      messages,
      turns,
      interactions: interactions.map((interaction) => ({ threadId: sessionId, interaction })),
    }
  }

  /**
   * `applySessionOpen` replaces the thread wholesale. If a turn was streaming
   * into this thread while the snapshot was being fetched, the snapshot cannot
   * contain its chunks (Convex holds them outside the message row until the
   * turn finalizes) and the delta events that built them will not come again.
   * The live turn, and everything the store accumulated for it, therefore
   * wins over whatever the snapshot says about that turn.
   */
  const preserveLiveTurn = (
    state: EnvironmentState,
    sessionId: string,
    live: ThreadState,
  ): EnvironmentState => {
    const liveTurn = live.turns.find((turn) => turn.state === 'running' || turn.state === 'waiting')
    const hydrated = state.threads[sessionId]
    if (!liveTurn || !hydrated) return state
    const isLive = (turnId: string) => turnId === liveTurn.turnId
    const notOpen = (turn: Turn) => turn.state !== 'running' && turn.state !== 'waiting'
    const liveMessages = live.messages.filter((message) => isLive(message.turnId))
    const liveMessageIds = new Set(liveMessages.map((message) => message.messageId))
    const merged: ThreadState = {
      ...hydrated,
      // The snapshot's own view of the open turn (possibly under a different,
      // user-message-derived ID) is superseded by the one the stream reported.
      turns: [...hydrated.turns.filter((turn) => notOpen(turn) && !isLive(turn.turnId)), liveTurn],
      messages: [
        ...hydrated.messages.filter(
          (message) => !isLive(message.turnId) && !liveMessageIds.has(message.messageId),
        ),
        ...liveMessages,
      ],
      reasoning: [
        ...hydrated.reasoning.filter((entry) => !isLive(entry.turnId)),
        ...live.reasoning.filter((entry) => isLive(entry.turnId)),
      ],
      tools: [
        ...hydrated.tools.filter((tool) => !isLive(tool.turnId)),
        ...live.tools.filter((tool) => isLive(tool.turnId)),
      ],
      interactions: [
        ...hydrated.interactions.filter(
          (item) =>
            !live.interactions.some(
              (pending) => pending.interaction.interactionId === item.interaction.interactionId,
            ),
        ),
        ...live.interactions,
      ],
    }
    const session = state.sessions[sessionId]
    const threads = { ...state.threads, [sessionId]: merged }
    if (!session) return { ...state, threads }
    const status = deriveSessionStatus(
      session.threadIds
        .map((id) => threads[id])
        .filter((thread): thread is ThreadState => !!thread),
    )
    return {
      ...state,
      threads,
      sessions: { ...state.sessions, [sessionId]: { ...session, status } },
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  const gate = () => {
    if (disposed) throw new EnvironmentClientError('unavailable', 'Client is disposed.')
    if (!connected) throw new EnvironmentClientError('unavailable', 'Not connected.')
  }

  const commands: EnvironmentCommands = {
    async getEnvironment() {
      gate()
      update((state) => applyEnvironment(state, environment))
      return environment
    },
    async listWorkspaces() {
      gate()
      const rows = await convex.query<WorkspaceRow[]>(api.workspaces.list, {})
      syncWorkspaces(rows)
      return rows.map(toWorkspace)
    },
    async addWorkspace(input) {
      gate()
      const row = await convex.mutation<WorkspaceRow | null>(api.workspaces.ensureByPath, {
        path: input.path,
        machineId: 'desktop',
      })
      const workspace: Workspace = row
        ? toWorkspace(row)
        : { workspaceId: input.path, name: input.name }
      update((state) => applyWorkspaceList(state, [workspace]))
      return workspace
    },
    async removeWorkspace(workspaceId) {
      gate()
      const row = await convex.query<WorkspaceRow | null>(api.workspaces.getByPath, {
        path: workspaceId,
      })
      if (row) await convex.mutation(api.workspaces.remove, { id: row._id })
      update((state) => applyWorkspaceRemoved(state, workspaceId))
    },
    async listSessions(workspaceId) {
      gate()
      const rows = await convex.query<SessionRow[]>(api.sessions.listByWorkspace, {
        workspacePath: workspaceId,
      })
      for (const row of rows) {
        if (isProvider(row.providerId)) providerBySession.set(row.externalId, row.providerId)
      }
      update((state) => {
        let next = applySessionList(
          state,
          rows.map((row) => toSession(row, workspaceId)),
        )
        for (const row of rows) next = knownThread(next, row.externalId)
        return next
      })
      return selectSessionList(store.getState(), workspaceId)
    },
    createSession(input) {
      gate()
      if (!store.getState().workspaces[input.workspaceId]) {
        return Promise.reject(new EnvironmentClientError('not_found', 'Workspace not found.'))
      }
      return serializeCreation(input.workspaceId, async () => {
        gate()
        const providerId = await bridge.getLastProviderId().catch((): ProviderId => 'opencode')
        const created = awaitSessionCreated(input.workspaceId)
        let job: ReturnType<typeof watchJob> | null = null
        try {
          const jobId = await submitJob(input.workspaceId, 'create_session', {
            providerId,
            ...(input.title ? { title: input.title } : {}),
          })
          job = watchJob(jobId)
          const sessionId = await withTimeout(
            Promise.race([created.promise, job.failed]),
            'the session to be created',
          )
          providerBySession.set(sessionId, providerId)
          const session: Session = {
            sessionId,
            workspaceId: input.workspaceId,
            title: input.title ?? null,
          }
          const thread = threadOf(sessionId)
          // The IPC announcement may have created the thread already (as
          // `idle`); a brand-new session has no history to fetch, so it is ready.
          update((state) =>
            applyThreadHydration(
              applySessionCreated(state, { session, thread }),
              thread.threadId,
              'ready',
            ),
          )
          return { session, thread }
        } finally {
          created.cancel()
          job?.stop()
        }
      })
    },
    async openSession(sessionId) {
      gate()
      const session = requireSession(sessionId)
      update((state) => applyThreadHydration(state, sessionId, 'loading'))
      let payload: SessionOpenPayload
      try {
        payload = await loadSession(sessionId, session.workspaceId)
      } catch (error) {
        update((state) => applyThreadHydration(state, sessionId, 'failed'))
        throw error
      }
      update((state) => {
        const live = state.threads[sessionId]
        let next = applySessionOpen(state, payload)
        if (live) next = preserveLiveTurn(next, sessionId, live)
        return applyActiveSession(next, sessionId)
      })
      const open = store
        .getState()
        .threads[sessionId]?.turns.find(
          (turn) => turn.state === 'running' || turn.state === 'waiting',
        )
      if (open) translator.adoptTurn(sessionId, open.turnId)
    },
    async renameSession(sessionId, title) {
      gate()
      const session = requireSession(sessionId)
      if (title === null || !title.trim()) {
        throw new EnvironmentClientError(
          'validation',
          'The Convex adapter cannot clear a session title.',
        )
      }
      await convex.mutation(api.sessions.upsertTitle, {
        workspacePath: session.workspaceId,
        externalId: sessionId,
        title,
        source: 'user',
        providerId: providerFor(sessionId),
        clientId,
      })
      update((state) => applySessionTitle(state, sessionId, title))
    },
    async deleteSession(sessionId) {
      gate()
      const session = requireSession(sessionId)
      await submitJob(
        session.workspaceId,
        'delete_session',
        { sessionExternalId: sessionId, providerId: providerFor(sessionId) },
        sessionId,
      )
      convexSessions.delete(sessionId)
      update((state) => applySessionRemoved(state, sessionId))
    },
    async sendTurn(input) {
      gate()
      const session = requireSession(input.sessionId)
      const userMessageId = `agent_usr_${crypto.randomUUID()}`
      const started = awaitTurnStarted(userMessageId)
      let job: ReturnType<typeof watchJob> | null = null
      try {
        const jobId = await submitJob(
          session.workspaceId,
          'send_message',
          {
            sessionExternalId: input.sessionId,
            content: input.text,
            attachments: [],
            userMessageId,
            providerId: providerFor(input.sessionId),
          },
          input.sessionId,
        )
        job = watchJob(jobId)
        // The event path has already folded `turn.started` into the store by
        // the time this resolves; the value is for the caller.
        return await withTimeout(Promise.race([started.promise, job.failed]), 'the turn to start')
      } finally {
        started.cancel()
        job?.stop()
      }
    },
    async interruptTurn(input) {
      gate()
      const session = requireSession(input.sessionId)
      await submitJob(
        session.workspaceId,
        'abort',
        { sessionExternalId: input.sessionId, providerId: providerFor(input.sessionId) },
        input.sessionId,
      )
    },
    async respondToInteraction(input) {
      gate()
      const session = requireSession(input.sessionId)
      const { response } = input
      const base = { sessionExternalId: input.sessionId, providerId: providerFor(input.sessionId) }
      const [type, payload] =
        response.kind === 'permission'
          ? [
              'resolve_permission',
              {
                ...base,
                permissionId: response.interactionId,
                ...(response.outcome.outcome === 'selected'
                  ? { optionId: response.outcome.optionId }
                  : { approved: false }),
              },
            ]
          : response.kind === 'question'
            ? [
                'resolve_question',
                { ...base, requestId: response.interactionId, outcome: response.outcome },
              ]
            : [
                'resolve_plan',
                { ...base, requestId: response.interactionId, outcome: response.outcome },
              ]
      const jobId = await submitJob(session.workspaceId, type, payload, input.sessionId)
      // The interaction stays pending until the provider's own settlement
      // event (`permission_resolved` and friends) clears it: a failed job
      // leaves the request open, and removing it here would hide the only
      // control the user has left. The job's terminal status is what this
      // command reports.
      const job = watchJob(jobId)
      try {
        await withTimeout(job.done, 'the answer to be delivered')
      } finally {
        job.stop()
      }
    },
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const teardown = () => {
    for (const unsubscribe of unsubscribeBridge) unsubscribe()
    unsubscribeBridge = []
    unsubscribeWorkspaces?.()
    unsubscribeWorkspaces = null
    unsubscribeSessions?.()
    unsubscribeSessions = null
    subscribedWorkspaceKey = ''
    connected = false
  }

  return {
    commands,
    getState: store.getState,
    subscribe: store.subscribe,
    supports: () => true,
    setActiveSession: (sessionId) => update((state) => applyActiveSession(state, sessionId)),
    setActiveThread: (threadId) => update((state) => applyActiveThread(state, threadId)),
    connect() {
      if (disposed || connected) return
      connected = true
      update((state) =>
        applyConnection(applyEnvironment(state, environment), {
          phase: 'connected',
          hasConnected: true,
          failure: null,
          capabilities: ALL_CAPABILITIES,
        }),
      )
      unsubscribeBridge = [bridge.onAcpEvent(ingest), bridge.onStreamToken(ingest)]
      unsubscribeWorkspaces = convex.subscribe<WorkspaceRow[]>(
        api.workspaces.list,
        {},
        syncWorkspaces,
      )
    },
    disconnect() {
      teardown()
      rejectWaiters(new EnvironmentClientError('unavailable', 'Disconnected.'))
      update((state) => applyConnection(state, { phase: 'closed', failure: null }))
    },
    dispose() {
      if (disposed) return
      disposed = true
      teardown()
      rejectWaiters(new EnvironmentClientError('unavailable', 'Client is disposed.'))
      update((state) => applyConnection(state, { phase: 'closed' }))
    },
  }
}
