import type {
  ContentBlock,
  Message,
  ProofEvent,
  ProofResponse,
  ScopeSnapshot,
  Session,
  SessionSummary as ProtocolSessionSummary,
  Thread,
  Turn,
  Workspace,
} from '@openmanager/protocol'
import type {
  ConnectionState,
  EnvironmentState,
  PendingInteraction,
  SessionStatus,
  SessionSummary,
  ThreadState,
} from './types'

export const INITIAL_CONNECTION: ConnectionState = {
  phase: 'idle',
  hasConnected: false,
  failure: null,
  capabilities: [],
}

export function createInitialState(): EnvironmentState {
  return {
    environment: null,
    workspaces: {},
    workspaceOrder: [],
    sessions: {},
    sessionOrder: [],
    threads: {},
    activeSessionId: null,
    activeThreadId: null,
    connection: INITIAL_CONNECTION,
  }
}

export function createThreadState(
  thread: Thread,
  hydration: ThreadState['hydration'] = 'idle',
): ThreadState {
  return {
    thread,
    turns: [],
    messages: [],
    reasoning: [],
    tools: [],
    interactions: [],
    failures: [],
    notices: [],
    hydration,
  }
}

const upsertById = <T>(items: readonly T[], id: (item: T) => string, next: T): T[] => {
  const key = id(next)
  const index = items.findIndex((item) => id(item) === key)
  if (index === -1) return [...items, next]
  const copy = items.slice()
  copy[index] = next
  return copy
}

const appendUnique = (order: readonly string[], id: string): string[] =>
  order.includes(id) ? [...order] : [...order, id]

export function deriveSessionStatus(threads: readonly ThreadState[]): SessionStatus {
  let status: SessionStatus = 'idle'
  for (const thread of threads) {
    for (const turn of thread.turns) {
      if (turn.state === 'waiting') return 'waiting'
      if (turn.state === 'running') status = 'running'
    }
    const last = thread.turns.at(-1)
    if (status === 'idle' && last?.state === 'failed') status = 'error'
  }
  return status
}

function refreshSessionStatus(state: EnvironmentState, sessionId: string): EnvironmentState {
  const session = state.sessions[sessionId]
  if (!session) return state
  const threads = session.threadIds
    .map((threadId) => state.threads[threadId])
    .filter((thread): thread is ThreadState => thread !== undefined)
  const status = deriveSessionStatus(threads)
  if (status === session.status) return state
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, status } } }
}

function upsertSession(
  state: EnvironmentState,
  session: Session | ProtocolSessionSummary,
  threadIds?: readonly string[],
): EnvironmentState {
  const existing = state.sessions[session.sessionId]
  const listed = session as Partial<ProtocolSessionSummary>
  const summary: SessionSummary = {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    title: session.title,
    status: listed.status ?? existing?.status ?? 'idle',
    providerId: listed.providerId ?? existing?.providerId,
    updatedAt: listed.updatedAt ?? existing?.updatedAt,
    threadIds: threadIds
      ? Array.from(new Set([...(existing?.threadIds ?? []), ...threadIds]))
      : (existing?.threadIds ?? []),
  }
  return {
    ...state,
    sessions: { ...state.sessions, [session.sessionId]: summary },
    sessionOrder: appendUnique(state.sessionOrder, session.sessionId),
  }
}

/** Move a session's workspace `lastActivityAt` forward to `at`, never back. */
function touchWorkspaceActivity(
  state: EnvironmentState,
  sessionId: string,
  at: string,
): EnvironmentState {
  const workspaceId = state.sessions[sessionId]?.workspaceId
  const workspace = workspaceId ? state.workspaces[workspaceId] : undefined
  if (!workspace) return state
  const current = workspace.lastActivityAt ? Date.parse(workspace.lastActivityAt) : -Infinity
  if (!(Date.parse(at) > current)) return state
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [workspace.workspaceId]: { ...workspace, lastActivityAt: at },
    },
  }
}

function upsertWorkspace(state: EnvironmentState, workspace: Workspace): EnvironmentState {
  return {
    ...state,
    workspaces: { ...state.workspaces, [workspace.workspaceId]: workspace },
    workspaceOrder: appendUnique(state.workspaceOrder, workspace.workspaceId),
  }
}

function ensureThread(state: EnvironmentState, thread: Thread): EnvironmentState {
  let next = state
  if (!next.threads[thread.threadId]) {
    next = { ...next, threads: { ...next.threads, [thread.threadId]: createThreadState(thread) } }
  }
  const session = next.sessions[thread.sessionId]
  if (session && !session.threadIds.includes(thread.threadId)) {
    next = {
      ...next,
      sessions: {
        ...next.sessions,
        [thread.sessionId]: { ...session, threadIds: [...session.threadIds, thread.threadId] },
      },
    }
  }
  return next
}

function patchThread(
  state: EnvironmentState,
  thread: Thread,
  update: (current: ThreadState) => ThreadState,
): EnvironmentState {
  const withThread = ensureThread(state, thread)
  const current = withThread.threads[thread.threadId]!
  const updated = update(current)
  if (updated === current) return withThread
  return refreshSessionStatus(
    { ...withThread, threads: { ...withThread.threads, [thread.threadId]: updated } },
    thread.sessionId,
  )
}

function setTurnState(thread: ThreadState, turnId: string, turnState: Turn['state']): ThreadState {
  const index = thread.turns.findIndex((turn) => turn.turnId === turnId)
  if (index === -1) {
    // A terminal event for a turn we never saw start (late join without a
    // snapshot). Record it so status derivation and history stay honest.
    return {
      ...thread,
      turns: [...thread.turns, { turnId, threadId: thread.thread.threadId, state: turnState }],
    }
  }
  if (thread.turns[index]!.state === turnState) return thread
  const turns = thread.turns.slice()
  turns[index] = { ...turns[index]!, state: turnState }
  return { ...thread, turns }
}

function mergeContent(existing: readonly ContentBlock[], delta: ContentBlock): ContentBlock[] {
  const last = existing.at(-1)
  if (last?.type === 'text' && delta.type === 'text') {
    return [...existing.slice(0, -1), { type: 'text', text: last.text + delta.text }]
  }
  return [...existing, delta]
}

/**
 * Drop a pending interaction and, when it was the last one blocking its turn,
 * return that turn to `running`. `turnId` may be null when the caller only
 * knows the interaction ID (the optimistic path); it is then looked up.
 */
function resolveInteraction(
  current: ThreadState,
  interactionId: string,
  turnId: string | null,
): ThreadState {
  const pending = current.interactions.find(
    (item) => item.interaction.interactionId === interactionId,
  )
  if (!pending) return current
  const resolvedTurnId = turnId ?? pending.turnId
  const interactions = current.interactions.filter(
    (item) => item.interaction.interactionId !== interactionId,
  )
  const stillWaiting = interactions.some((item) => item.turnId === resolvedTurnId)
  const turn = current.turns.find((item) => item.turnId === resolvedTurnId)
  const updated =
    turn?.state === 'waiting' && !stillWaiting
      ? setTurnState(current, resolvedTurnId, 'running')
      : current
  return { ...updated, interactions }
}

function removeSession(state: EnvironmentState, sessionId: string): EnvironmentState {
  const session = state.sessions[sessionId]
  if (!session) return state
  const sessions = { ...state.sessions }
  delete sessions[sessionId]
  const threads = { ...state.threads }
  for (const threadId of session.threadIds) delete threads[threadId]
  const clearActive = state.activeSessionId === sessionId
  return {
    ...state,
    sessions,
    sessionOrder: state.sessionOrder.filter((id) => id !== sessionId),
    threads,
    activeSessionId: clearActive ? null : state.activeSessionId,
    activeThreadId: clearActive ? null : state.activeThreadId,
    sessionOpenFailure:
      state.sessionOpenFailure?.sessionId === sessionId ? null : state.sessionOpenFailure,
  }
}

/**
 * Fold one live event into the state. Branches keyed by resource ID
 * (sessions, turns, tools, interactions) are idempotent, so a replayed event
 * cannot double-apply. Delta events (`message.delta`, `message.reasoning`,
 * `turn.notice`) append and are not; the transport de-duplicates those by
 * cursor, and event-ID tracking for replay lands with CAL-71.
 */
export function applyEvent(state: EnvironmentState, event: ProofEvent): EnvironmentState {
  switch (event.name) {
    case 'workspace.updated':
      return upsertWorkspace(state, event.payload.workspace)
    case 'workspace.removed':
      return applyWorkspaceRemoved(state, event.payload.workspaceId)
    case 'session.created':
      return touchWorkspaceActivity(
        upsertSession(state, event.payload.session),
        event.payload.session.sessionId,
        event.timestamp,
      )
    case 'session.updated': {
      const session = state.sessions[event.payload.sessionId]
      if (!session || event.payload.title === undefined) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, title: event.payload.title },
        },
      }
    }
    case 'session.deleted':
      return removeSession(state, event.payload.sessionId)
    case 'thread.created':
      return ensureThread(state, event.payload.thread)
    default:
      break
  }

  const scope = event.scope
  if (scope.type !== 'thread') return state
  const thread: Thread = { threadId: scope.threadId, sessionId: scope.sessionId }

  switch (event.name) {
    case 'turn.started':
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
      // A turn is session activity; keep the workspace's recency current
      // between listings instead of waiting for the next handshake.
      state = touchWorkspaceActivity(state, thread.sessionId, event.timestamp)
      break
    default:
      break
  }

  switch (event.name) {
    case 'turn.started':
      return patchThread(state, thread, (current) => ({
        ...current,
        turns: upsertById(current.turns, (turn) => turn.turnId, event.payload.turn),
        messages: upsertById(
          current.messages,
          (message) => message.messageId,
          event.payload.userMessage,
        ),
      }))
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed': {
      const turnState =
        event.name === 'turn.completed'
          ? 'completed'
          : event.name === 'turn.interrupted'
            ? 'interrupted'
            : 'failed'
      return patchThread(state, thread, (current) => {
        const updated = setTurnState(current, event.payload.turnId, turnState)
        const interactions = updated.interactions.filter(
          (item) => item.turnId !== event.payload.turnId,
        )
        const failures =
          event.name === 'turn.failed'
            ? upsertById(updated.failures, (item) => item.turnId, {
                turnId: event.payload.turnId,
                reason: event.payload.reason,
                message: event.payload.message,
              })
            : updated.failures
        return { ...updated, interactions, failures }
      })
    }
    case 'turn.notice':
      return patchThread(state, thread, (current) => ({
        ...current,
        notices: [...current.notices, event.payload],
      }))
    case 'message.delta':
      return patchThread(state, thread, (current) => {
        const existing = current.messages.find(
          (message) => message.messageId === event.payload.messageId,
        )
        const message: Message = existing
          ? { ...existing, content: mergeContent(existing.content, event.payload.content) }
          : {
              messageId: event.payload.messageId,
              threadId: thread.threadId,
              turnId: event.payload.turnId,
              role: event.payload.role,
              content: [event.payload.content],
            }
        return {
          ...current,
          messages: upsertById(current.messages, (item) => item.messageId, message),
        }
      })
    case 'message.reasoning':
      return patchThread(state, thread, (current) => {
        const existing = current.reasoning.find(
          (entry) => entry.messageId === event.payload.messageId,
        )
        const content =
          event.payload.content === undefined
            ? (existing?.content ?? [])
            : mergeContent(existing?.content ?? [], event.payload.content)
        return {
          ...current,
          reasoning: upsertById(current.reasoning, (entry) => entry.messageId, {
            messageId: event.payload.messageId,
            turnId: event.payload.turnId,
            phase: event.payload.phase,
            content,
            tokens: event.payload.tokens ?? existing?.tokens,
          }),
        }
      })
    case 'tool.updated':
      return patchThread(state, thread, (current) => {
        const existing = current.tools.find((tool) => tool.toolCallId === event.payload.toolCallId)
        return {
          ...current,
          tools: upsertById(current.tools, (tool) => tool.toolCallId, {
            ...existing,
            ...event.payload,
          }),
        }
      })
    case 'interaction.requested':
      return patchThread(state, thread, (current) => {
        const pending: PendingInteraction = {
          sessionId: thread.sessionId,
          threadId: thread.threadId,
          turnId: event.payload.turnId,
          interaction: event.payload.interaction,
        }
        const updated = setTurnState(current, event.payload.turnId, 'waiting')
        return {
          ...updated,
          interactions: upsertById(
            updated.interactions,
            (item) => item.interaction.interactionId,
            pending,
          ),
        }
      })
    case 'interaction.resolved':
      return patchThread(state, thread, (current) =>
        resolveInteraction(current, event.payload.response.interactionId, event.payload.turnId),
      )
    default:
      return state
  }
}

/** Replace a scope wholesale. Threads outside the snapshot are untouched. */
export function applySnapshot(state: EnvironmentState, snapshot: ScopeSnapshot): EnvironmentState {
  const scope = snapshot.cursor.scope
  if (scope.type === 'environment') {
    const { environment, workspaces, sessions } = (
      snapshot as Extract<ScopeSnapshot, { cursor: { scope: { type: 'environment' } } }>
    ).state
    let next: EnvironmentState = { ...state, environment }
    for (const workspace of workspaces) next = upsertWorkspace(next, workspace)
    for (const session of sessions) next = upsertSession(next, session)
    return next
  }
  if (scope.type === 'session') {
    const { session, threads } = (
      snapshot as Extract<ScopeSnapshot, { cursor: { scope: { type: 'session' } } }>
    ).state
    let next = upsertSession(state, session)
    for (const thread of threads) next = ensureThread(next, thread)
    return next
  }
  const threadSnapshot = (
    snapshot as Extract<ScopeSnapshot, { cursor: { scope: { type: 'thread' } } }>
  ).state
  const thread = threadSnapshot.thread
  const withThread = ensureThread(state, thread)
  const replaced: ThreadState = {
    ...createThreadState(thread, 'ready'),
    turns: threadSnapshot.turns,
    messages: threadSnapshot.messages,
    reasoning: threadSnapshot.reasoning,
    tools: threadSnapshot.tools,
    interactions: threadSnapshot.interactions.map((item) => ({
      sessionId: thread.sessionId,
      threadId: thread.threadId,
      turnId: item.turnId,
      interaction: item.interaction,
    })),
  }
  return refreshSessionStatus(
    { ...withThread, threads: { ...withThread.threads, [thread.threadId]: replaced } },
    thread.sessionId,
  )
}

/** `session.open` loads identities only; `session.history` hydrates the transcript. */
export function applySessionOpen(
  state: EnvironmentState,
  payload: ProofResponse<'session.open'>['payload'],
): EnvironmentState {
  let next = upsertSession(
    state,
    payload.session,
    payload.threads.map((thread) => thread.threadId),
  )
  for (const thread of payload.threads) {
    const current = next.threads[thread.threadId]
    next = {
      ...next,
      threads: {
        ...next.threads,
        [thread.threadId]: current
          ? { ...current, thread, hydration: current.hydration === 'ready' ? 'ready' : 'loading' }
          : createThreadState(thread, 'loading'),
      },
    }
  }
  return refreshSessionStatus(next, payload.session.sessionId)
}

/** Fold one history page into a thread. Newer pages replace; older pages prepend. */
export function applySessionHistory(
  state: EnvironmentState,
  thread: Thread,
  payload: ProofResponse<'session.history'>['payload'],
): EnvironmentState {
  return patchThread(state, thread, (current) => {
    const existingIds = new Set(current.messages.map((message) => message.messageId))
    const incoming = payload.messages.filter((message) => !existingIds.has(message.messageId))
    const messages =
      current.hydration !== 'ready' ? payload.messages : [...incoming, ...current.messages]
    const openTurn = payload.turns.find(
      (turn) => turn.state === 'waiting' || turn.state === 'running',
    )
    const interactions: PendingInteraction[] = payload.interactions
      .filter((item) => item.threadId === thread.threadId)
      .map((item) => ({
        sessionId: thread.sessionId,
        threadId: thread.threadId,
        turnId: openTurn?.turnId ?? payload.turns.at(-1)?.turnId ?? '',
        interaction: item.interaction,
      }))
    return {
      ...current,
      turns: payload.turns.length > 0 ? payload.turns : current.turns,
      messages,
      interactions:
        interactions.length > 0 || current.hydration !== 'ready'
          ? interactions
          : current.interactions,
      hydration: 'ready',
    }
  })
}

/** Same shape as `turn.started`; used to fold a `turn.send` response in before the event arrives. */
export function applyTurnStarted(
  state: EnvironmentState,
  thread: Thread,
  payload: { turn: Turn; userMessage: Message },
): EnvironmentState {
  return patchThread(state, thread, (current) => ({
    ...current,
    turns: upsertById(current.turns, (turn) => turn.turnId, payload.turn),
    messages: upsertById(current.messages, (message) => message.messageId, payload.userMessage),
  }))
}

/**
 * Optimistic removal after `interaction.respond`. Mirrors the
 * `interaction.resolved` event path so the turn returns to `running` here; the
 * later event is then a no-op instead of the only place that flips the turn.
 */
export function applyInteractionResolved(
  state: EnvironmentState,
  thread: Thread,
  interactionId: string,
): EnvironmentState {
  return patchThread(state, thread, (current) => resolveInteraction(current, interactionId, null))
}

export function applySessionCreated(
  state: EnvironmentState,
  payload: { session: Session; thread: Thread },
): EnvironmentState {
  const withSession = upsertSession(state, payload.session, [payload.thread.threadId])
  if (withSession.threads[payload.thread.threadId]) return withSession
  return {
    ...withSession,
    threads: {
      ...withSession.threads,
      [payload.thread.threadId]: createThreadState(payload.thread, 'ready'),
    },
  }
}

export function applySessionList(
  state: EnvironmentState,
  sessions: readonly (Session | ProtocolSessionSummary)[],
): EnvironmentState {
  let next = state
  for (const session of sessions) next = upsertSession(next, session)
  return next
}

export function applyWorkspaceList(
  state: EnvironmentState,
  workspaces: readonly Workspace[],
): EnvironmentState {
  let next = state
  for (const workspace of workspaces) next = upsertWorkspace(next, workspace)
  return next
}

export function applyWorkspaceRemoved(
  state: EnvironmentState,
  workspaceId: string,
): EnvironmentState {
  if (!state.workspaces[workspaceId]) return state
  const workspaces = { ...state.workspaces }
  delete workspaces[workspaceId]
  let next: EnvironmentState = {
    ...state,
    workspaces,
    workspaceOrder: state.workspaceOrder.filter((id) => id !== workspaceId),
  }
  for (const session of Object.values(state.sessions)) {
    if (session.workspaceId === workspaceId) next = removeSession(next, session.sessionId)
  }
  return next
}

export function applySessionRemoved(state: EnvironmentState, sessionId: string): EnvironmentState {
  return removeSession(state, sessionId)
}

export function applySessionTitle(
  state: EnvironmentState,
  sessionId: string,
  title: string | null,
): EnvironmentState {
  const session = state.sessions[sessionId]
  if (!session || session.title === title) return state
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, title } } }
}

export function applyThreadHydration(
  state: EnvironmentState,
  threadId: string,
  hydration: ThreadState['hydration'],
): EnvironmentState {
  const thread = state.threads[threadId]
  if (!thread || thread.hydration === hydration) return state
  return { ...state, threads: { ...state.threads, [threadId]: { ...thread, hydration } } }
}

export function applyActiveSession(
  state: EnvironmentState,
  sessionId: string | null,
): EnvironmentState {
  const session = sessionId ? state.sessions[sessionId] : undefined
  const nextSessionId = session ? sessionId : null
  const nextThreadId = session?.threadIds[0] ?? null
  if (
    state.activeSessionId === nextSessionId &&
    state.activeThreadId === nextThreadId &&
    !state.sessionOpenFailure
  ) {
    return state
  }
  return {
    ...state,
    activeSessionId: nextSessionId,
    activeThreadId: nextThreadId,
    sessionOpenFailure: null,
  }
}

export function applyActiveThread(
  state: EnvironmentState,
  threadId: string | null,
): EnvironmentState {
  const thread = threadId ? state.threads[threadId] : undefined
  if (threadId && !thread) return state
  const sessionId = thread?.thread.sessionId ?? state.activeSessionId
  if (state.activeThreadId === threadId && state.activeSessionId === sessionId) return state
  return { ...state, activeThreadId: thread ? threadId : null, activeSessionId: sessionId }
}

export function applyConnection(
  state: EnvironmentState,
  patch: Partial<ConnectionState>,
): EnvironmentState {
  return { ...state, connection: { ...state.connection, ...patch } }
}

export function applyEnvironment(
  state: EnvironmentState,
  environment: EnvironmentState['environment'],
): EnvironmentState {
  const current = state.environment
  // Every reconnect re-announces the same environment; keep the state
  // identity so subscribers do not re-render for it.
  if (
    current === environment ||
    (current &&
      environment &&
      current.environmentId === environment.environmentId &&
      current.name === environment.name)
  ) {
    return state
  }
  return { ...state, environment }
}

// ---------------------------------------------------------------------------
// Selectors. Pure and cheap; React bindings memoize by state identity.
// ---------------------------------------------------------------------------

export function selectWorkspaces(state: EnvironmentState): Workspace[] {
  return state.workspaceOrder
    .map((id) => state.workspaces[id])
    .filter((workspace): workspace is Workspace => workspace !== undefined)
}

/**
 * Workspaces with recorded session activity, most recent first, for the
 * new-chat surface. Missing folders and never-used workspaces are left out:
 * a recent is a place you can go back to. Ties keep listing order.
 */
export function selectRecentWorkspaces(state: EnvironmentState, limit = 5): Workspace[] {
  return selectWorkspaces(state)
    .filter((workspace) => workspace.exists && workspace.lastActivityAt !== null)
    .sort((a, b) => Date.parse(b.lastActivityAt!) - Date.parse(a.lastActivityAt!))
    .slice(0, Math.max(0, limit))
}

export function selectSessionList(state: EnvironmentState, workspaceId?: string): SessionSummary[] {
  const sessions = state.sessionOrder
    .map((id) => state.sessions[id])
    .filter((session): session is SessionSummary => session !== undefined)
  return workspaceId ? sessions.filter((session) => session.workspaceId === workspaceId) : sessions
}

export function selectActiveSession(state: EnvironmentState): SessionSummary | null {
  return state.activeSessionId ? (state.sessions[state.activeSessionId] ?? null) : null
}

export function selectActiveThread(state: EnvironmentState): ThreadState | null {
  return state.activeThreadId ? (state.threads[state.activeThreadId] ?? null) : null
}

export function selectActiveTurn(state: EnvironmentState): Turn | null {
  const thread = selectActiveThread(state)
  if (!thread) return null
  return thread.turns.find((turn) => turn.state === 'running' || turn.state === 'waiting') ?? null
}

export function selectPendingInteractions(
  state: EnvironmentState,
  threadId: string | null = state.activeThreadId,
): PendingInteraction[] {
  if (threadId) return state.threads[threadId]?.interactions ?? []
  return Object.values(state.threads).flatMap((thread) => thread.interactions)
}

export function selectConnection(state: EnvironmentState): ConnectionState {
  return state.connection
}

export function shallowEqualArray<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((item, index) => Object.is(item, right[index]))
}
