import { foldProtocolEvent, placeActivity } from '@agentpack/view/protocol'
import type {
  BackgroundTask,
  InteractionKind,
  Message,
  ProofEvent,
  ProofResponse,
  ProviderBootstrap,
  ProviderCatalogEntry,
  ProviderHealth,
  ScopeSnapshot,
  Session,
  SessionSummary as ProtocolSessionSummary,
  Thread,
  Turn,
  TurnStart,
  TurnStarted,
  Workspace,
  WorkspaceComposerPreference,
} from '@openmanager/protocol'
import type {
  ActivityRef,
  ConnectionState,
  EnvironmentState,
  OutboxEntry,
  PendingInteraction,
  SessionComposerState,
  SessionStatus,
  SessionSummary,
  ThreadState,
} from './types'
import { emptyOverlay } from './overlay'
import {
  applyDraftDeleted,
  applyDraftSaved,
  detachWorkspaceEdits,
  removeSessionDrafts,
} from './draft-state'

export const INITIAL_CONNECTION: ConnectionState = {
  phase: 'idle',
  hasConnected: false,
  failure: null,
  capabilities: [],
  attempt: 0,
  retriesExhausted: false,
}

export function createInitialState(): EnvironmentState {
  return {
    environment: null,
    workspaces: {},
    workspaceOrder: [],
    sessions: {},
    sessionOrder: [],
    threads: {},
    providers: {},
    providerOrder: [],
    composerPreferences: {},
    composerRevisions: {},
    drafts: {},
    draftTombstones: {},
    draftEdits: {},
    draftsListed: false,
    activeSessionId: null,
    activeThreadId: null,
    connection: INITIAL_CONNECTION,
    pending: emptyOverlay(),
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
    order: [],
    interactions: [],
    notices: [],
    outbox: [],
    hydration,
  }
}

/**
 * Structural sharing: `next`, except that any part deep-equal to the same part
 * of `previous` is `previous`'s object. A replace that changes nothing hands
 * every reader the objects it already holds, so nothing re-renders and the
 * transcript keeps its scroll anchor (docs/sync-foundations.md §6.2).
 */
function share<T>(previous: T | undefined, next: T): T {
  if (previous === undefined || Object.is(previous, next)) return next
  if (
    typeof previous !== 'object' ||
    typeof next !== 'object' ||
    previous === null ||
    next === null
  ) {
    return next
  }
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  if (Array.isArray(next)) {
    const before = previous as unknown as unknown[]
    let same = before.length === next.length
    const items = next.map((item, index) => {
      const kept = share(before[index], item)
      if (kept !== before[index]) same = false
      return kept
    })
    return same ? previous : (items as unknown as T)
  }
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  let same = keys.length === Object.keys(before).length
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const kept = share(before[key], after[key])
    if (kept !== before[key] || !(key in before)) same = false
    out[key] = kept
  }
  return same ? previous : (out as T)
}

/** `next` by id, each entry sharing what it can with the entry of the same id in `previous`. */
function shareById<T>(previous: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const held = new Map(previous.map((item) => [key(item), item]))
  const items = next.map((item) => share(held.get(key(item)), item))
  return items.length === previous.length && items.every((item, index) => item === previous[index])
    ? (previous as T[])
    : items
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

/**
 * File a session as the environment states it. Every source states the whole
 * summary (a snapshot, `session.created`, `session.open`), so this replaces
 * the held one; `threadIds` are the session's own list when the source names
 * them (`session.open`, a session snapshot), and kept otherwise.
 */
function upsertSession(
  state: EnvironmentState,
  session: ProtocolSessionSummary,
  threadIds?: readonly string[],
): EnvironmentState {
  const existing = state.sessions[session.sessionId]
  const summary = share(existing, {
    ...(session as SessionSummary),
    threadIds: threadIds ? [...threadIds] : (existing?.threadIds ?? []),
  })
  if (existing === summary) return state
  return {
    ...state,
    sessions: { ...state.sessions, [session.sessionId]: summary },
    sessionOrder: appendUnique(state.sessionOrder, session.sessionId),
  }
}

/** Field by field; thread lists by their members, since a listing rebuilds them. */
function sameSummary(left: SessionSummary, right: SessionSummary): boolean {
  const keys = Object.keys(left) as (keyof SessionSummary)[]
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) =>
    key === 'threadIds'
      ? left.threadIds.length === right.threadIds.length &&
        left.threadIds.every((id, index) => id === right.threadIds[index])
      : Object.is(left[key], right[key]),
  )
}

/**
 * A session's background work after a report of it: the reported roster, or
 * the held one when nothing was said. No work is no key at all, and the held
 * list is kept when nothing changed, so selectors stay stable.
 */
/** Each only means something beside the status it belongs to. */
function activityOf(
  status: SessionStatus,
  waitingOn: InteractionKind | null | undefined,
  inBackground: boolean | undefined,
): Pick<SessionSummary, 'waitingOn' | 'inBackground'> {
  return {
    ...(status === 'waiting' && waitingOn ? { waitingOn } : {}),
    ...(status === 'running' && inBackground ? { inBackground: true as const } : {}),
  }
}

function backgroundOf(
  reported: BackgroundTask[] | undefined,
  held: BackgroundTask[] | undefined,
): Pick<SessionSummary, 'backgroundTasks'> {
  const tasks = reported ?? held
  if (!tasks?.length) return {}
  return { backgroundTasks: held && sameJson(tasks, held) ? held : tasks }
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
  return { ...withThread, threads: { ...withThread.threads, [thread.threadId]: updated } }
}

/**
 * The state of a turn the thread holds, as an interaction event states it
 * (`turnState`). The server says it; the client never derives it from the
 * requests it holds. A turn the thread does not hold is left alone: the
 * transport recovers the scope (`namesUnknownTurn`).
 */
function setTurnState(thread: ThreadState, turnId: string, turnState: Turn['state']): ThreadState {
  const index = thread.turns.findIndex((turn) => turn.turnId === turnId)
  if (index === -1 || thread.turns[index]!.state === turnState) return thread
  const turns = thread.turns.slice()
  turns[index] = { ...turns[index]!, state: turnState }
  return { ...thread, turns }
}

/** Drop a pending interaction; the turn's state is the event's to say. */
function dropInteraction(current: ThreadState, interactionId: string): ThreadState {
  if (!current.interactions.some((item) => item.interaction.interactionId === interactionId)) {
    return current
  }
  return {
    ...current,
    interactions: current.interactions.filter(
      (item) => item.interaction.interactionId !== interactionId,
    ),
  }
}

/**
 * Drop one session, its threads and its draft. The environment announces
 * every session a deletion takes, each child before its parent, so the
 * client mirrors no cascade (docs/sync-foundations.md §3.6 row 12).
 */
function removeSession(state: EnvironmentState, sessionId: string): EnvironmentState {
  const removed = new Set([sessionId])
  if (!(sessionId in state.sessions)) return removeSessionDrafts(state, removed)
  const sessions = { ...state.sessions }
  const threads = { ...state.threads }
  for (const id of removed) {
    for (const threadId of sessions[id]?.threadIds ?? []) delete threads[threadId]
    delete sessions[id]
  }
  const clearActive = state.activeSessionId !== null && removed.has(state.activeSessionId)
  return {
    ...removeSessionDrafts(state, removed),
    sessions,
    sessionOrder: state.sessionOrder.filter((id) => !removed.has(id)),
    threads,
    activeSessionId: clearActive ? null : state.activeSessionId,
    activeThreadId: clearActive ? null : state.activeThreadId,
    sessionOpenFailure:
      state.sessionOpenFailure && removed.has(state.sessionOpenFailure.sessionId)
        ? null
        : state.sessionOpenFailure,
  }
}

/**
 * Fold one live event into the state. Branches keyed by resource ID
 * (sessions, turns, tools, interactions) are idempotent, so a replayed event
 * cannot double-apply. Delta events (`message.delta`, `message.reasoning`,
 * `turn.notice`) append and are not; the transport de-duplicates those by
 * cursor at the snapshot/replay boundary.
 */
export function applyEvent(state: EnvironmentState, event: ProofEvent): EnvironmentState {
  switch (event.name) {
    case 'workspace.updated':
      return upsertWorkspace(state, event.payload.workspace)
    case 'workspace.removed':
      // Its sessions went, and its drafts were detached, on events before it (row 13).
      return detachWorkspaceEdits(
        applyWorkspaceRemoved(state, event.payload.workspaceId),
        event.payload.workspaceId,
      )
    case 'session.created':
      // The whole row, provider and time included (§4.7.2). Its workspace's
      // recency comes on the environment's own `workspace.updated` (§4.7.1).
      return upsertSession(state, event.payload.session)
    case 'session.updated': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { title, status, updatedAt, settledAt, doneAt, backgroundTasks } = event.payload
      const {
        backgroundTasks: heldTasks,
        waitingOn: heldWaitingOn,
        inBackground: heldInBackground,
        ...held
      } = session
      // A status event says what goes with its status, so one that leaves
      // these out (an older environment) clears them.
      const restated = status !== undefined
      const next: SessionSummary = {
        ...held,
        ...backgroundOf(backgroundTasks, heldTasks),
        ...activityOf(
          status ?? session.status,
          event.payload.waitingOn !== undefined
            ? event.payload.waitingOn
            : restated
              ? null
              : heldWaitingOn,
          event.payload.inBackground !== undefined
            ? event.payload.inBackground
            : restated
              ? false
              : heldInBackground,
        ),
        ...(event.payload.titleSource ? { titleSource: event.payload.titleSource } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(settledAt !== undefined ? { settledAt } : {}),
        ...(doneAt !== undefined ? { doneAt } : {}),
        // The session's place moves only when the environment says so (§4.7.1).
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      }
      // An event that restates what the client already holds (the echo of a
      // command whose answer it applied) must not hand every reader a new
      // session: the whole sidebar would render again for nothing.
      return sameSummary(session, next)
        ? state
        : { ...state, sessions: { ...state.sessions, [session.sessionId]: next } }
    }
    case 'session.composer.updated': {
      // Announced only through the sidebar list: a session this client has
      // not listed yet picks its selection up with the listing.
      const session = state.sessions[event.payload.sessionId]
      if (!session || (session.composer && sameJson(session.composer, event.payload.composer))) {
        return state
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, composer: event.payload.composer },
        },
      }
    }
    case 'composer.preferences.updated':
      // A workspace this client no longer lists must not get a preference back.
      return state.workspaces[event.payload.workspaceId]
        ? applyComposerPreference(
            state,
            event.payload,
            event.payload.preference,
            event.payload.revision,
          )
        : state
    case 'provider.catalog.updated': {
      // Only a loaded catalog is patched; an unloaded one reads the profile
      // with `provider.catalog.get`, which also brings the health it needs.
      const profile = event.payload.profile
      const provider = state.providers[profile.providerId]
      if (!provider || (provider.profile && sameJson(provider.profile, profile))) return state
      return {
        ...state,
        providers: { ...state.providers, [profile.providerId]: { ...provider, profile } },
      }
    }
    case 'session.deleted':
      return removeSession(state, event.payload.sessionId)
    case 'draft.saved':
      return applyDraftSaved(state, event.payload.draft)
    case 'draft.deleted':
      return applyDraftDeleted(state, event.payload)
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
      return patchThread(state, thread, (current) => applyStart(current, event.payload))
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
    case 'message.delta':
    case 'message.reasoning':
    case 'tool.updated':
      return patchThread(state, thread, (current) => foldProtocolEvent(current, event))
    case 'turn.notice':
      return patchThread(state, thread, (current) => ({
        ...current,
        notices: [...current.notices, event.payload],
      }))
    case 'interaction.requested':
      return patchThread(state, thread, (current) => {
        if (!current.turns.some((turn) => turn.turnId === event.payload.turnId)) return current
        const pending: PendingInteraction = {
          sessionId: thread.sessionId,
          threadId: thread.threadId,
          turnId: event.payload.turnId,
          interaction: event.payload.interaction,
        }
        const updated = setTurnState(current, event.payload.turnId, event.payload.turnState)
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
    case 'interaction.expired':
    case 'interaction.cancelled':
      return patchThread(state, thread, (current) =>
        setTurnState(
          dropInteraction(current, event.payload.response.interactionId),
          event.payload.turnId,
          event.payload.turnState,
        ),
      )
    default:
      return state
  }
}

/**
 * Replace a scope with its snapshot (docs/sync-foundations.md §6.2). Only the
 * server-owned part is replaced: drafts, selection, connection and the
 * pending overlay stay, and unchanged objects keep their identity.
 *
 * - **Environment:** the environment, workspaces, sessions and their orders,
 *   composer preferences and provider profiles. Threads of sessions that no
 *   longer exist go.
 * - **Session:** its summary and its thread list.
 * - **Thread:** turns, messages, reasoning, tools, order and pending
 *   requests. The client's own echoes are settled against it; notices start
 *   over (the transport places held transients after it).
 */
export function applySnapshot(state: EnvironmentState, snapshot: ScopeSnapshot): EnvironmentState {
  const scope = snapshot.cursor.scope
  if (scope.type === 'environment') {
    return replaceEnvironment(
      state,
      (snapshot as Extract<ScopeSnapshot, { cursor: { scope: { type: 'environment' } } }>).state,
    )
  }
  if (scope.type === 'session') {
    const { session, threads } = (
      snapshot as Extract<ScopeSnapshot, { cursor: { scope: { type: 'session' } } }>
    ).state
    let next = upsertSession(
      state,
      session,
      threads.map((thread) => thread.threadId),
    )
    for (const thread of threads) next = ensureThread(next, thread)
    return next
  }
  const snapshotState = (
    snapshot as Extract<ScopeSnapshot, { cursor: { scope: { type: 'thread' } } }>
  ).state
  const thread = snapshotState.thread
  const withThread = ensureThread(state, thread)
  const existing = withThread.threads[thread.threadId]!
  const messages = shareById(existing.messages, snapshotState.messages, (item) => item.messageId)
  const replaced: ThreadState = {
    ...createThreadState(share(existing.thread, thread), 'ready'),
    // Which messages were this client's echoes is the client's own
    // knowledge, settled by the turns the snapshot holds.
    ...reconcileOutbox(existing, snapshotState.turns, snapshotState.messages),
    turns: shareById(existing.turns, snapshotState.turns, (item) => item.turnId),
    messages,
    reasoning: shareById(existing.reasoning, snapshotState.reasoning, (item) => item.messageId),
    tools: shareById(existing.tools, snapshotState.tools, (item) => item.toolCallId),
    order: share(existing.order, snapshotState.order),
    interactions: shareById(
      existing.interactions,
      snapshotState.interactions.map((item) => ({
        sessionId: thread.sessionId,
        threadId: thread.threadId,
        turnId: item.turnId,
        interaction: item.interaction,
      })),
      (item) => item.interaction.interactionId,
    ),
  }
  return { ...withThread, threads: { ...withThread.threads, [thread.threadId]: replaced } }
}

type EnvironmentSnapshotState = Extract<
  ScopeSnapshot,
  { cursor: { scope: { type: 'environment' } } }
>['state']

function replaceEnvironment(
  state: EnvironmentState,
  snapshot: EnvironmentSnapshotState,
): EnvironmentState {
  const workspaces: EnvironmentState['workspaces'] = {}
  for (const workspace of snapshot.workspaces) {
    workspaces[workspace.workspaceId] = share(state.workspaces[workspace.workspaceId], workspace)
  }
  const sessions: EnvironmentState['sessions'] = {}
  for (const session of snapshot.sessions) {
    const existing = state.sessions[session.sessionId]
    sessions[session.sessionId] = share(existing, {
      ...(session as SessionSummary),
      threadIds: existing?.threadIds ?? [],
    })
  }
  const threads: EnvironmentState['threads'] = {}
  for (const [threadId, thread] of Object.entries(state.threads)) {
    if (sessions[thread.thread.sessionId]) threads[threadId] = thread
  }
  const composerPreferences: EnvironmentState['composerPreferences'] = {}
  const composerRevisions: EnvironmentState['composerRevisions'] = {}
  for (const entry of snapshot.preferences) {
    composerPreferences[entry.workspaceId] = {
      ...composerPreferences[entry.workspaceId],
      [entry.providerId]: share(
        state.composerPreferences[entry.workspaceId]?.[entry.providerId],
        entry.preference,
      ),
    }
    composerRevisions[entry.workspaceId] = {
      ...composerRevisions[entry.workspaceId],
      [entry.providerId]: entry.revision,
    }
  }
  const profiles = new Map(
    snapshot.providerProfiles.map((profile) => [profile.providerId, profile]),
  )
  const providers: EnvironmentState['providers'] = {}
  for (const [providerId, provider] of Object.entries(state.providers)) {
    const profile = profiles.get(providerId)
    const { profile: held, ...rest } = provider
    providers[providerId] = share(
      provider,
      profile ? { ...rest, profile: share(held, profile) } : rest,
    )
  }
  const activeGone = state.activeSessionId !== null && !sessions[state.activeSessionId]
  return {
    ...state,
    environment: share(state.environment ?? undefined, snapshot.environment),
    workspaces: share(state.workspaces, workspaces),
    workspaceOrder: share(
      state.workspaceOrder,
      snapshot.workspaces.map((workspace) => workspace.workspaceId),
    ),
    sessions: share(state.sessions, sessions),
    sessionOrder: share(
      state.sessionOrder,
      snapshot.sessions.map((session) => session.sessionId),
    ),
    threads:
      Object.keys(threads).length === Object.keys(state.threads).length ? state.threads : threads,
    composerPreferences: share(state.composerPreferences, composerPreferences),
    composerRevisions: share(state.composerRevisions, composerRevisions),
    providers: share(state.providers, providers),
    activeSessionId: activeGone ? null : state.activeSessionId,
    activeThreadId: activeGone ? null : state.activeThreadId,
  }
}

/** `session.open` loads identities only; the thread's snapshot brings the transcript. */
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
  // The server summary is authoritative while history is still loading.
  return next
}

/**
 * Settle the echoes whose turns the environment has, by command id
 * (`Turn.commandId`; docs/sync-foundations.md §3.6 rows 21 and 22). A send
 * whose connection dropped is reported as failed although its turn may well
 * have started; a snapshot or history page that brings that turn back ends
 * the echo, pending or failed, and records which message took its place, the
 * way a `turn.started` does.
 */
function reconcileOutbox(
  current: ThreadState,
  turns: readonly Turn[],
  messages: readonly Message[],
): Pick<ThreadState, 'outbox' | 'confirmedEchoes'> {
  const unchanged = {
    outbox: current.outbox,
    ...(current.confirmedEchoes ? { confirmedEchoes: current.confirmedEchoes } : {}),
  }
  if (current.outbox.length === 0) return unchanged
  const started = new Map<string, Turn>()
  for (const turn of turns) if (turn.commandId) started.set(turn.commandId, turn)
  const confirmedEchoes = { ...current.confirmedEchoes }
  const outbox = current.outbox.filter((entry) => {
    const turn = started.get(entry.commandId)
    if (!turn) return true
    const prompt = messages.find(
      (message) => message.turnId === turn.turnId && message.role === 'user',
    )
    if (prompt) confirmedEchoes[prompt.messageId] = entry.commandId
    return false
  })
  return outbox.length === current.outbox.length ? unchanged : { outbox, confirmedEchoes }
}

/**
 * A turn's start, as `turn.started` states it: the turn, its prompt, and the
 * echo its command id settles, with the message recorded as that echo's (see
 * `confirmedEchoes`). A start the thread already holds (a replayed tail) is
 * no change: the turn may have moved on since.
 */
function applyStart(current: ThreadState, payload: TurnStarted): ThreadState {
  const commandId = payload.commandId ?? payload.turn.commandId
  const outbox = commandId
    ? current.outbox.filter((entry) => entry.commandId !== commandId)
    : current.outbox
  const known = current.turns.some((turn) => turn.turnId === payload.turn.turnId)
  const turns = known ? current.turns : [...current.turns, payload.turn]
  // A turn the provider began by itself has no prompt: a background task
  // finished and the agent is acting on the result.
  const { userMessage } = payload
  const settled = outbox.length !== current.outbox.length
  if (!userMessage) {
    return known && !settled ? current : { ...current, turns, ...(settled ? { outbox } : {}) }
  }
  return {
    ...current,
    turns,
    messages: upsertById(current.messages, (message) => message.messageId, userMessage),
    order: placeActivity(current.order, {
      kind: 'message',
      id: userMessage.messageId,
      turnId: payload.turn.turnId,
    }),
    ...(settled
      ? {
          outbox,
          confirmedEchoes: { ...current.confirmedEchoes, [userMessage.messageId]: commandId! },
        }
      : {}),
  }
}

/**
 * A created session's chat as its `session.create` answer described it:
 * shown by the overlay until the chat itself holds the first turn
 * (overlay.ts). Built over what the client holds of the thread, if anything.
 */
export function provisionalThread(
  thread: Thread,
  firstTurn: TurnStart,
  held?: ThreadState,
): ThreadState {
  const base = held ?? createThreadState(thread, 'ready')
  const turns = upsertById(base.turns, (item) => item.turnId, firstTurn.turn)
  const { userMessage } = firstTurn
  return {
    ...base,
    hydration: 'ready',
    turns,
    ...(userMessage
      ? {
          messages: upsertById(base.messages, (message) => message.messageId, userMessage),
          order: placeActivity(base.order, {
            kind: 'message',
            id: userMessage.messageId,
            turnId: firstTurn.turn.turnId,
          }),
        }
      : {}),
  }
}

/** A session as `upsertSession` files it, for the overlay's created sessions. */
export const withSessionUpserted = (
  state: EnvironmentState,
  session: ProtocolSessionSummary,
  threadIds?: readonly string[],
) => upsertSession(state, session, threadIds)

/**
 * Echo a send locally before the environment has answered. A repeat of a
 * command id — a retry — reuses its row and clears the previous failure
 * instead of adding a second one.
 */
export function applyTurnSending(
  state: EnvironmentState,
  thread: Thread,
  send: { commandId: string; text: string; artifactIds?: string[] },
): EnvironmentState {
  const entry: OutboxEntry = {
    commandId: send.commandId,
    text: send.text,
    ...(send.artifactIds?.length ? { artifactIds: send.artifactIds } : {}),
    status: 'pending',
  }
  return patchThread(state, thread, (current) =>
    // A retry of a send whose turn this client already holds: the answer
    // comes from the environment's log and no event follows, so there is
    // nothing to echo.
    current.turns.some((turn) => turn.commandId === send.commandId)
      ? current
      : { ...current, outbox: upsertById(current.outbox, (item) => item.commandId, entry) },
  )
}

/** Mark an echoed send failed, keeping it on screen with the reason. */
export function applyTurnSendFailed(
  state: EnvironmentState,
  thread: Thread,
  commandId: string,
  message: string,
): EnvironmentState {
  return patchThread(state, thread, (current) => {
    const entry = current.outbox.find((item) => item.commandId === commandId)
    if (!entry) return current
    return {
      ...current,
      outbox: upsertById(current.outbox, (item) => item.commandId, {
        ...entry,
        status: 'failed',
        error: message,
      }),
    }
  })
}

/**
 * A created session, from the command's answer. That answer arrives before the
 * `session.created` event, so it carries the announcement time: without it the
 * session would be listed as the oldest, at the bottom of the sidebar, and move
 * to the top once the event came. With it the event restates what is held.
 *
 * The answer is a bare `Session`; the caller fills the summary's required
 * fields from what it already has, the provider it asked for and the
 * announcement time, until the `pending.creates` overlay replaces this writer
 * (docs/sync-foundations.md §4.7.2, decision D7).
 */
export function applySessionCreated(
  state: EnvironmentState,
  payload: { session: Session; thread: Thread; announcedAt: string },
  providerId: string,
): EnvironmentState {
  const { announcedAt } = payload
  const existing = state.sessions[payload.session.sessionId]
  const upserted = upsertSession(
    state,
    {
      ...payload.session,
      providerId,
      // An event that already arrived is newer than this answer: keep what it said.
      ...(existing
        ? {
            status: existing.status,
            updatedAt: existing.updatedAt,
            settledAt: existing.settledAt ?? null,
            doneAt: existing.doneAt ?? null,
            ...(existing.backgroundTasks ? { backgroundTasks: existing.backgroundTasks } : {}),
            ...(existing.waitingOn ? { waitingOn: existing.waitingOn } : {}),
            ...(existing.inBackground ? { inBackground: existing.inBackground } : {}),
          }
        : { status: 'idle' as const, updatedAt: announcedAt, settledAt: null, doneAt: null }),
    },
    [payload.thread.threadId],
  )
  const withSession = upserted
  if (withSession.threads[payload.thread.threadId]) return withSession
  return {
    ...withSession,
    threads: {
      ...withSession.threads,
      [payload.thread.threadId]: createThreadState(payload.thread, 'ready'),
    },
  }
}

export function applyWorkspaceList(
  state: EnvironmentState,
  workspaces: readonly Workspace[],
): EnvironmentState {
  let next = state
  for (const workspace of workspaces) next = upsertWorkspace(next, workspace)
  return next
}

/**
 * Drop a workspace and what is read per workspace. Its sessions and drafts
 * are not touched here: the environment announces each change to them.
 */
export function applyWorkspaceRemoved(
  state: EnvironmentState,
  workspaceId: string,
): EnvironmentState {
  if (!state.workspaces[workspaceId]) return state
  const workspaces = { ...state.workspaces }
  delete workspaces[workspaceId]
  const composerPreferences = { ...state.composerPreferences }
  delete composerPreferences[workspaceId]
  const composerRevisions = { ...state.composerRevisions }
  delete composerRevisions[workspaceId]
  return {
    ...state,
    workspaces,
    workspaceOrder: state.workspaceOrder.filter((id) => id !== workspaceId),
    composerPreferences,
    composerRevisions,
  }
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/**
 * The catalog is a whole read, not a patch: a provider the environment no
 * longer lists is dropped. Unchanged entries keep their identity so a refresh
 * does not re-render every picker.
 */
export function applyProviderCatalog(
  state: EnvironmentState,
  catalog: readonly ProviderCatalogEntry[],
): EnvironmentState {
  const providers: Record<string, ProviderCatalogEntry> = {}
  for (const entry of catalog) {
    const existing = state.providers[entry.id]
    providers[entry.id] = existing && sameJson(existing, entry) ? existing : entry
  }
  const providerOrder = Object.keys(providers)
  const unchanged =
    shallowEqualArray(providerOrder, state.providerOrder) &&
    providerOrder.every((id) => providers[id] === state.providers[id])
  return unchanged ? state : { ...state, providers, providerOrder }
}

/**
 * The handshake's provider list: who exists and how healthy they are, without
 * composer profiles. A profile this client already read is kept, so a
 * reconnect does not blank the pickers until the next catalog read lands.
 */
export function applyProviderBootstrap(
  state: EnvironmentState,
  bootstrap: readonly ProviderBootstrap[],
): EnvironmentState {
  return applyProviderCatalog(
    state,
    bootstrap.map((entry) => {
      const profile = state.providers[entry.id]?.profile
      return profile ? { ...entry, profile } : entry
    }),
  )
}

/** One provider's health moved. A provider this client does not list is ignored. */
export function applyProviderHealth(
  state: EnvironmentState,
  providerId: string,
  health: ProviderHealth,
): EnvironmentState {
  const provider = state.providers[providerId]
  if (!provider || sameJson(provider.health, health)) return state
  return { ...state, providers: { ...state.providers, [providerId]: { ...provider, health } } }
}

/** A probe answers with the whole provider entry, minus the composer profile. */
export function applyProviderProbe(
  state: EnvironmentState,
  probed: ProviderBootstrap,
): EnvironmentState {
  const existing = state.providers[probed.id]
  const next: ProviderCatalogEntry = existing?.profile
    ? { ...probed, profile: existing.profile }
    : probed
  if (existing && sameJson(existing, next)) return state
  return {
    ...state,
    providers: { ...state.providers, [probed.id]: next },
    providerOrder: existing ? state.providerOrder : [...state.providerOrder, probed.id],
  }
}

/** Replaces the remembered choice for one workspace and provider. */
/**
 * A preference as the server stated it at `revision`, from an event or a read
 * answer. Ordered by the server's number, never by arrival: an older or equal
 * revision changes nothing (docs/sync-foundations.md §3.2, §4.7.10).
 */
export function applyComposerPreference(
  state: EnvironmentState,
  target: { workspaceId: string; providerId: string },
  preference: WorkspaceComposerPreference,
  revision: number,
): EnvironmentState {
  const held = state.composerRevisions[target.workspaceId]?.[target.providerId]
  if (held !== undefined && held >= revision) return state
  const workspace = state.composerPreferences[target.workspaceId]
  const same = workspace?.[target.providerId] && sameJson(workspace[target.providerId], preference)
  return {
    ...state,
    composerPreferences: same
      ? state.composerPreferences
      : {
          ...state.composerPreferences,
          [target.workspaceId]: { ...workspace, [target.providerId]: preference },
        },
    composerRevisions: {
      ...state.composerRevisions,
      [target.workspaceId]: {
        ...state.composerRevisions[target.workspaceId],
        [target.providerId]: revision,
      },
    },
  }
}

/** Forget every held preference, so each reads as "not loaded" until asked for again. */
export function applyComposerPreferencesReset(state: EnvironmentState): EnvironmentState {
  return Object.keys(state.composerPreferences).length === 0 &&
    Object.keys(state.composerRevisions).length === 0
    ? state
    : { ...state, composerPreferences: {}, composerRevisions: {} }
}

export function applySessionRemoved(state: EnvironmentState, sessionId: string): EnvironmentState {
  return removeSession(state, sessionId)
}

export function applySessionTitle(
  state: EnvironmentState,
  sessionId: string,
  title: string | null,
  titleSource: 'user' | 'generated' = 'user',
): EnvironmentState {
  const session = state.sessions[sessionId]
  if (!session || (session.title === title && session.titleSource === titleSource)) return state
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...session, title, titleSource } },
  }
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

/**
 * A session this client may select: listed by the server, or just created
 * and shown by the overlay until it is (pending.creates). Selection is the
 * client's own state, so it may follow either.
 */
function selectableSession(
  state: EnvironmentState,
  sessionId: string,
): { threadIds: readonly string[] } | undefined {
  const created = state.pending?.creates[sessionId]
  return (
    state.sessions[sessionId] ?? (created ? { threadIds: [created.thread.threadId] } : undefined)
  )
}

export function applyActiveSession(
  state: EnvironmentState,
  sessionId: string | null,
): EnvironmentState {
  const session = sessionId ? selectableSession(state, sessionId) : undefined
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

/**
 * A session being opened. It goes on screen now rather than when
 * `session.open` answers: the threads already known read as loading, and
 * with none known yet the view waits for the first. Leaving the selection
 * empty in between showed the new-session landing for as long as the open
 * took. Opening the session already shown keeps its thread, and a failure
 * stays up while that same session is retried.
 */
export function applySessionOpening(state: EnvironmentState, sessionId: string): EnvironmentState {
  const session = selectableSession(state, sessionId)
  let next = state
  for (const threadId of session?.threadIds ?? []) {
    next = applyThreadHydration(next, threadId, 'loading')
  }
  if (session && next.activeSessionId !== sessionId) next = applyActiveSession(next, sessionId)
  const failure =
    state.sessionOpenFailure?.sessionId === sessionId ? state.sessionOpenFailure : null
  return (next.sessionOpenFailure ?? null) === failure
    ? next
    : { ...next, sessionOpenFailure: failure }
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

export function selectProviderCatalog(state: EnvironmentState): ProviderCatalogEntry[] {
  return state.providerOrder
    .map((id) => state.providers[id])
    .filter((provider): provider is ProviderCatalogEntry => provider !== undefined)
}

/** Null until the environment has reported a selection for this session. */
export function selectSessionComposer(
  state: EnvironmentState,
  sessionId: string,
): SessionComposerState | null {
  return state.sessions[sessionId]?.composer ?? null
}

/** Null until a composer command has answered for this workspace and provider. */
export function selectComposerPreference(
  state: EnvironmentState,
  workspaceId: string,
  providerId: string,
): WorkspaceComposerPreference | null {
  return state.composerPreferences[workspaceId]?.[providerId] ?? null
}

/**
 * Newest first, on the same `(updatedAt, sessionId)` key the environment
 * lists by. `sessionOrder` is arrival order and cannot be trusted for the
 * sidebar: a session created after the first listing is appended at the end,
 * and one that becomes active again never moves. Ties, and sessions with no
 * timestamp (which sort as the epoch), fall back to the id so the order is
 * stable across renders.
 */
export function selectSessionList(state: EnvironmentState, workspaceId?: string): SessionSummary[] {
  // Every store update runs this for the sidebar, a streamed token included;
  // only a change to the sessions themselves sorts them again.
  let cached = sessionLists.get(state.sessions)
  if (!cached || cached.order !== state.sessionOrder) {
    cached = { order: state.sessionOrder, lists: new Map() }
    sessionLists.set(state.sessions, cached)
  }
  const key = workspaceId ?? ''
  const listed = cached.lists.get(key)
  if (listed) return listed
  const all = cached.lists.get('') ?? sortNewestFirst(state)
  cached.lists.set('', all)
  const list = workspaceId ? all.filter((session) => session.workspaceId === workspaceId) : all
  cached.lists.set(key, list)
  return list
}

/** Sorted lists by the sessions they were read from, per workspace (`''` for all). */
const sessionLists = new WeakMap<
  EnvironmentState['sessions'],
  { order: EnvironmentState['sessionOrder']; lists: Map<string, SessionSummary[]> }
>()

function sortNewestFirst(state: EnvironmentState): SessionSummary[] {
  const keyed: { session: SessionSummary; at: number }[] = []
  for (const id of state.sessionOrder) {
    const session = state.sessions[id]
    if (session)
      keyed.push({ session, at: Date.parse(session.updatedAt ?? '1970-01-01T00:00:00.000Z') })
  }
  return keyed
    .sort((left, right) => {
      const time = right.at - left.at
      if (time !== 0) return time
      const a = left.session.sessionId
      const b = right.session.sessionId
      return b < a ? -1 : b > a ? 1 : 0
    })
    .map(({ session }) => session)
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
