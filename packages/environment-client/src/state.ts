import type {
  ContentBlock,
  Message,
  ProofEvent,
  ProofResponse,
  ScopeSnapshot,
  Session,
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
  session: Session,
  threadIds?: readonly string[],
): EnvironmentState {
  const existing = state.sessions[session.sessionId]
  const summary: SessionSummary = {
    ...session,
    status: existing?.status ?? 'idle',
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
  }
}

/**
 * Fold one live event into the state. Every branch is idempotent by resource
 * ID so a replayed or duplicated event cannot double-apply.
 */
export function applyEvent(state: EnvironmentState, event: ProofEvent): EnvironmentState {
  switch (event.name) {
    case 'workspace.updated':
      return upsertWorkspace(state, event.payload.workspace)
    case 'session.created':
      return upsertSession(state, event.payload.session)
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
      return patchThread(state, thread, (current) => {
        const interactionId = event.payload.response.interactionId
        const interactions = current.interactions.filter(
          (item) => item.interaction.interactionId !== interactionId,
        )
        if (interactions.length === current.interactions.length) return current
        const stillWaiting = interactions.some((item) => item.turnId === event.payload.turnId)
        const turn = current.turns.find((item) => item.turnId === event.payload.turnId)
        const updated =
          turn?.state === 'waiting' && !stillWaiting
            ? setTurnState(current, event.payload.turnId, 'running')
            : current
        return { ...updated, interactions }
      })
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

/** `session.open` is the proof-slice hydration path until replay lands (CAL-71). */
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
    const turns = payload.turns.filter((turn) => turn.threadId === thread.threadId)
    const messages = payload.messages.filter((message) => message.threadId === thread.threadId)
    const openTurn = turns.find((turn) => turn.state === 'waiting' || turn.state === 'running')
    const interactions: PendingInteraction[] = payload.interactions
      .filter((item) => item.threadId === thread.threadId)
      .map((item) => ({
        sessionId: thread.sessionId,
        threadId: thread.threadId,
        turnId: openTurn?.turnId ?? turns.at(-1)?.turnId ?? '',
        interaction: item.interaction,
      }))
    next = {
      ...next,
      threads: {
        ...next.threads,
        [thread.threadId]: {
          ...createThreadState(thread, 'ready'),
          turns,
          messages,
          interactions,
        },
      },
    }
  }
  return refreshSessionStatus(next, payload.session.sessionId)
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

export function applyInteractionResolved(
  state: EnvironmentState,
  thread: Thread,
  interactionId: string,
): EnvironmentState {
  return patchThread(state, thread, (current) => {
    const interactions = current.interactions.filter(
      (item) => item.interaction.interactionId !== interactionId,
    )
    return interactions.length === current.interactions.length
      ? current
      : { ...current, interactions }
  })
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
  sessions: readonly Session[],
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
  if (state.activeSessionId === nextSessionId && state.activeThreadId === nextThreadId) {
    return state
  }
  return { ...state, activeSessionId: nextSessionId, activeThreadId: nextThreadId }
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
  if (state.environment === environment) return state
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
