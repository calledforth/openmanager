import { foldProtocolEvent, isTurnSettled, placeActivity } from '@agentpack/view/protocol'
import { sessionListCursorOf, utf8Bytes } from '@openmanager/protocol'
import type {
  BackgroundTask,
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
  ToolState,
} from './types'
import {
  applyDraftDeleted,
  applyDraftSaved,
  detachWorkspaceDrafts,
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
    drafts: {},
    draftTombstones: {},
    draftEdits: {},
    draftsListed: false,
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
    order: [],
    interactions: [],
    failures: [],
    notices: [],
    outbox: [],
    hydration,
  }
}

/**
 * The transcript order a page of persisted messages implies on its own. An
 * environment that keeps no reasoning or tool state (an older one, or a
 * snapshot that starts them over) still lists its messages in order.
 */
function orderOfMessages(messages: readonly Message[]): ActivityRef[] {
  return messages.map((message) => ({
    kind: 'message',
    id: message.messageId,
    turnId: message.turnId,
  }))
}

/** `primary`, then the entries of `secondary` whose key `primary` lacks. */
function mergeById<T>(
  primary: readonly T[],
  secondary: readonly T[],
  key: (item: T) => string,
): T[] {
  const known = new Set(primary.map(key))
  const extra = secondary.filter((item) => !known.has(key(item)))
  return extra.length === 0 ? [...primary] : [...primary, ...extra]
}

/** `base`, then whatever `extra` places that `base` does not, in `extra`'s order. */
function mergeOrder(base: readonly ActivityRef[], extra: readonly ActivityRef[]): ActivityRef[] {
  const placed = new Set(base.map((ref) => `${ref.kind}:${ref.id}`))
  const merged = [...base]
  for (const ref of extra) {
    const key = `${ref.kind}:${ref.id}`
    if (placed.has(key)) continue
    placed.add(key)
    merged.push(ref)
  }
  return merged
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

function upsertSession(
  state: EnvironmentState,
  session: Session | ProtocolSessionSummary,
  threadIds?: readonly string[],
  /** When the session names no `updatedAt`, the time it was announced. */
  at?: string,
): EnvironmentState {
  const existing = state.sessions[session.sessionId]
  const listed = session as Partial<ProtocolSessionSummary>
  const titleSource = listed.titleSource ?? existing?.titleSource
  const parentSessionId = session.parentSessionId ?? existing?.parentSessionId
  const summary: SessionSummary = {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    title: session.title,
    ...(titleSource ? { titleSource } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    status: listed.status ?? existing?.status ?? 'idle',
    providerId: listed.providerId ?? existing?.providerId,
    updatedAt: listed.updatedAt ?? existing?.updatedAt ?? at,
    ...settledOf(listed.settledAt, existing?.settledAt),
    ...doneOf(listed.doneAt, existing?.doneAt),
    // A full summary is the whole truth: naming no background work means
    // there is none, which is how work that died with a restarted environment
    // is cleared. A bare `Session` says nothing either way.
    ...backgroundOf(
      listed.status === undefined ? undefined : (listed.backgroundTasks ?? []),
      existing?.backgroundTasks,
    ),
    ...composerOf(listed.composer, existing?.composer),
    threadIds: threadIds
      ? Array.from(new Set([...(existing?.threadIds ?? []), ...threadIds]))
      : (existing?.threadIds ?? []),
  }
  // Listing again (a reconnect, the next page) restates most sessions as they
  // are; keeping those objects keeps every reader of them still.
  if (existing && sameSummary(existing, summary)) return state
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

/** A listing that says nothing about settling (an older environment) keeps what is known. */
function settledOf(
  listed: string | null | undefined,
  existing: string | null | undefined,
): Pick<SessionSummary, 'settledAt'> {
  const settledAt = listed !== undefined ? listed : existing
  return settledAt !== undefined ? { settledAt } : {}
}

/** Likewise for unseen completions: silence from an older environment keeps what is known. */
function doneOf(
  listed: string | null | undefined,
  existing: string | null | undefined,
): Pick<SessionSummary, 'doneAt'> {
  const doneAt = listed !== undefined ? listed : existing
  return doneAt !== undefined ? { doneAt } : {}
}

/**
 * A session's background work after a report of it: the reported roster, or
 * the held one when nothing was said. No work is no key at all, and the held
 * list is kept when nothing changed, so selectors stay stable.
 */
function backgroundOf(
  reported: BackgroundTask[] | undefined,
  held: BackgroundTask[] | undefined,
): Pick<SessionSummary, 'backgroundTasks'> {
  const tasks = reported ?? held
  if (!tasks?.length) return {}
  return { backgroundTasks: held && sameJson(tasks, held) ? held : tasks }
}

/**
 * A listing that names a selection is current; one that does not (a bare
 * `Session`, an older environment) must not erase what an event delivered.
 * The held object is kept when nothing changed, so selectors stay stable.
 */
function composerOf(
  listed: SessionComposerState | undefined,
  existing: SessionComposerState | undefined,
): { composer?: SessionComposerState } {
  const composer =
    listed && existing && sameJson(listed, existing) ? existing : (listed ?? existing)
  return composer ? { composer } : {}
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
  return { ...withThread, threads: { ...withThread.threads, [thread.threadId]: updated } }
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

/**
 * Drop a session and every child under it. The environment deletes children
 * with their parent and announces only the parent, so the client mirrors the
 * cascade instead of leaving orphaned subagent rows in the sidebar.
 */
function removeSession(state: EnvironmentState, sessionId: string): EnvironmentState {
  // The parent itself may never have been loaded (a paginated list can bring
  // a child in first), so descendants are searched for regardless.
  const removed = new Set<string>()
  const pending = [sessionId]
  while (pending.length) {
    const id = pending.pop()!
    if (removed.has(id)) continue
    removed.add(id)
    for (const session of Object.values(state.sessions)) {
      if (session.parentSessionId === id) pending.push(session.sessionId)
    }
  }
  if (![...removed].some((id) => id in state.sessions)) return removeSessionDrafts(state, removed)
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
 * `turn.notice`, and a `tool.updated` carrying `outputDelta`) append and are
 * not; the transport de-duplicates those by cursor at the snapshot/replay
 * boundary.
 */
export function applyEvent(state: EnvironmentState, event: ProofEvent): EnvironmentState {
  switch (event.name) {
    case 'workspace.updated':
      return upsertWorkspace(state, event.payload.workspace)
    case 'workspace.removed':
      return detachWorkspaceDrafts(
        applyWorkspaceRemoved(state, event.payload.workspaceId),
        event.payload.workspaceId,
      )
    case 'session.created':
      // The announced session carries no `updatedAt`; without the event time
      // it would sort as the epoch and a brand-new session would open at the
      // bottom of the sidebar.
      return touchWorkspaceActivity(
        upsertSession(state, event.payload.session, undefined, event.timestamp),
        event.payload.session.sessionId,
        event.timestamp,
      )
    case 'session.updated': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { title, status, settledAt, doneAt, backgroundTasks } = event.payload
      const { backgroundTasks: heldTasks, ...held } = session
      const next: SessionSummary = {
        ...held,
        ...backgroundOf(backgroundTasks, heldTasks),
        ...(event.payload.titleSource ? { titleSource: event.payload.titleSource } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(settledAt !== undefined ? { settledAt } : {}),
        ...(doneAt !== undefined ? { doneAt } : {}),
        // Settling or acknowledging alone is not activity; the session keeps its place.
        ...(title !== undefined || status !== undefined ? { updatedAt: event.timestamp } : {}),
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
        ? applyComposerPreference(state, event.payload, event.payload.preference)
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
      return patchThread(state, thread, (current) =>
        confirmTurnStart(current, event.payload, event.timestamp),
      )
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
    case 'interaction.expired':
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
  const existing = withThread.threads[thread.threadId]!
  const messages = retainOlderMessages(existing.messages, threadSnapshot.messages)
  const older = olderActivity(
    existing,
    messages.slice(0, messages.length - threadSnapshot.messages.length),
    threadSnapshot.order ?? orderOfMessages(threadSnapshot.messages),
  )
  const replaced: ThreadState = {
    ...createThreadState(thread, 'ready'),
    // A snapshot describes what the environment has; a send it has not
    // answered yet is still the client's to show, unless the snapshot is
    // itself the answer.
    outbox: reconcileOutbox(existing, threadSnapshot.messages),
    turns: threadSnapshot.turns,
    messages,
    // Older pages the client keeps in front of the snapshot keep everything
    // they placed; the snapshot places its own page, reasoning and tools
    // included when the environment reports them.
    order: older.order,
    historyCursor:
      existing.historyCursor !== undefined &&
      existing.messages.findIndex(
        (message) => message.messageId === threadSnapshot.messages[0]?.messageId,
      ) > 0
        ? existing.historyCursor
        : threadSnapshot.nextCursor,
    reasoning: older.keep(
      'reasoning',
      existing.reasoning,
      threadSnapshot.reasoning,
      (entry) => entry.messageId,
    ),
    tools: older.keep('tool', existing.tools, threadSnapshot.tools, (tool) => tool.toolCallId),
    interactions: threadSnapshot.interactions.map((item) => ({
      sessionId: thread.sessionId,
      threadId: thread.threadId,
      turnId: item.turnId,
      interaction: item.interaction,
    })),
  }
  return { ...withThread, threads: { ...withThread.threads, [thread.threadId]: replaced } }
}

/**
 * What a snapshot leaves of the client's older history. A snapshot carries the
 * newest page only, and its window starts right after the last older message
 * the client keeps (see `retainOlderMessages`): everything the client placed
 * up to that message is history the snapshot predates, and stays, whatever
 * its kind. Anything placed after it is the snapshot's to say.
 *
 * `order` is the retained older order followed by the snapshot's. `keep`
 * merges one activity list the same way: the retained older entries of that
 * kind, then the snapshot's. Every kind of activity a page carries goes
 * through `keep`, so a new kind joins without its own rule.
 */
function olderActivity(
  existing: ThreadState,
  olderMessages: readonly Message[],
  snapshotOrder: readonly ActivityRef[],
) {
  const last = olderMessages.at(-1)
  const end = last
    ? existing.order.findIndex((ref) => ref.kind === 'message' && ref.id === last.messageId)
    : -1
  const inSnapshot = new Set(snapshotOrder.map((ref) => `${ref.kind}:${ref.id}`))
  const retained = (
    !last ? [] : end === -1 ? orderOfMessages(olderMessages) : existing.order.slice(0, end + 1)
  ).filter((ref) => !inSnapshot.has(`${ref.kind}:${ref.id}`))
  const kept = new Set(retained.map((ref) => `${ref.kind}:${ref.id}`))
  return {
    order: [...retained, ...snapshotOrder],
    keep<T>(
      kind: ActivityRef['kind'],
      held: readonly T[],
      fresh: readonly T[],
      id: (item: T) => string,
    ): T[] {
      const freshIds = new Set(fresh.map(id))
      return [
        ...held.filter((item) => kept.has(`${kind}:${id(item)}`) && !freshIds.has(id(item))),
        ...fresh,
      ]
    },
  }
}

/**
 * The older tool calls a client kept through a snapshot that may be out of
 * date: the snapshot does not name them, they are still open as the client
 * last saw them, and the snapshot says their turn has ended. They may have
 * completed, failed or been declined while the client was away, or have been
 * cancelled by a restart; only the environment knows which, so they are left
 * as they are until `applyToolStates` brings its answer (see the history walk
 * after a snapshot in `websocket.ts`). Guessing would show wrong outcomes.
 */
export function staleRetainedTools(state: EnvironmentState, snapshot: ScopeSnapshot): string[] {
  if (snapshot.cursor.scope.type !== 'thread') return []
  const held = state.threads[snapshot.cursor.scope.threadId]
  if (!held) return []
  const named = snapshot.state as { tools?: readonly ToolState[]; turns?: readonly Turn[] }
  const fresh = new Set((named.tools ?? []).map((tool) => tool.toolCallId))
  const ended = new Set((named.turns ?? []).filter(isTurnSettled).map((turn) => turn.turnId))
  return held.tools
    .filter(
      (tool) =>
        !fresh.has(tool.toolCallId) &&
        ended.has(tool.turnId) &&
        (tool.status === undefined || tool.status === 'pending' || tool.status === 'in_progress'),
    )
    .map((tool) => tool.toolCallId)
}

/**
 * The environment's word on tool calls the client already holds, read from a
 * history page: each named call takes the page's fields over its own. Calls the
 * client does not hold are not added, and nothing else of the page is applied,
 * so the thread's messages, order and history cursor stay as they are.
 */
export function applyToolStates(
  state: EnvironmentState,
  thread: Thread,
  tools: readonly ToolState[],
): EnvironmentState {
  if (tools.length === 0) return state
  const byId = new Map(tools.map((tool) => [tool.toolCallId, tool]))
  return patchThread(state, thread, (current) => {
    if (!current.tools.some((tool) => byId.has(tool.toolCallId))) return current
    return {
      ...current,
      tools: current.tools.map((tool) => {
        const known = byId.get(tool.toolCallId)
        return known && known.turnId === tool.turnId ? mergeToolState(tool, known) : tool
      }),
    }
  })
}

/** The bytes of output a value actually shows: its start and its newest end. */
const shownOutputBytes = (output: ToolState['output']) =>
  output ? utf8Bytes(output.text) + utf8Bytes(output.tail ?? '') : -1

/**
 * A history page's word on a held call. Its state (status, times, name, title,
 * kind, line changes) is the environment's and wins. Its payload may be cut
 * to fit the page, or be only a marker, so the held payload stays unless the
 * page shows at least as much output, and input and locations fill in only
 * where the client has none.
 */
function mergeToolState(held: ToolState, page: ToolState): ToolState {
  const next: ToolState = { ...held }
  for (const key of [
    'status',
    'startedAt',
    'finishedAt',
    'toolName',
    'title',
    'kind',
    'lineChanges',
  ] as const) {
    if (page[key] !== undefined) Object.assign(next, { [key]: page[key] })
  }
  if (page.output && shownOutputBytes(page.output) >= shownOutputBytes(held.output)) {
    next.output = page.output
  }
  if (held.input === undefined && page.input !== undefined) next.input = page.input
  if (held.locations === undefined && page.locations !== undefined) next.locations = page.locations
  return next
}

/**
 * A thread snapshot carries the newest page of messages. History is only ever
 * appended to and the client keeps it in order, so everything it holds before
 * the first message the page names is older than the page: earlier pages it
 * loaded. Those stay in front of the snapshot, in the order they were in, and
 * the cursor the host keeps for the next older page stays valid. Anything
 * after that point that the page does not name is not history the page
 * predates, so the page's word is final for it.
 */
function retainOlderMessages(known: readonly Message[], newest: readonly Message[]): Message[] {
  if (known.length === 0) return [...newest]
  const inSnapshot = new Set(newest.map((message) => message.messageId))
  const overlap = known.findIndex((message) => inSnapshot.has(message.messageId))
  const older = overlap === -1 ? [] : known.slice(0, overlap)
  return older.length === 0 ? [...newest] : [...older, ...newest]
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
  // The server summary is authoritative while history is still loading.
  return next
}

/** Fold one history page into a thread. Newer pages replace; older pages prepend. */
export function applySessionHistory(
  state: EnvironmentState,
  thread: Thread,
  payload: ProofResponse<'session.history'>['payload'],
  older = false,
): EnvironmentState {
  // A resumed transcript with no turns has no turn state to derive a status
  // from, so the persisted one stands.
  const persistedStatus = state.sessions[thread.sessionId]?.status
  const next = patchThread(state, thread, (current) => {
    const existingIds = new Set(current.messages.map((message) => message.messageId))
    const incoming = payload.messages.filter((message) => !existingIds.has(message.messageId))
    const messages =
      !older && current.hydration !== 'ready'
        ? payload.messages
        : [...incoming, ...current.messages]
    // The page places its messages, reasoning and tools in the order they
    // happened; an older environment names messages only. Live activity that
    // arrived while the page loaded keeps the place it already has, after
    // everything the page names.
    const pageOrder = payload.order ?? orderOfMessages(payload.messages)
    const fresh = !older && current.hydration !== 'ready'
    const order = fresh
      ? mergeOrder(pageOrder, current.order)
      : [
          ...pageOrder.filter(
            (ref) => !current.order.some((known) => known.kind === ref.kind && known.id === ref.id),
          ),
          ...current.order,
        ]
    // Reasoning and tools are keyed by id, so a page's entries replace what
    // the client held for them and leave live ones it does not name alone.
    const reasoning = fresh
      ? mergeById(payload.reasoning ?? [], current.reasoning, (entry) => entry.messageId)
      : mergeById(current.reasoning, payload.reasoning ?? [], (entry) => entry.messageId)
    const tools = fresh
      ? mergeById(payload.tools ?? [], current.tools, (tool) => tool.toolCallId)
      : mergeById(current.tools, payload.tools ?? [], (tool) => tool.toolCallId)
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
      turns: older
        ? [
            ...payload.turns.filter(
              (turn) => !current.turns.some((known) => known.turnId === turn.turnId),
            ),
            ...current.turns,
          ]
        : payload.turns.length > 0
          ? payload.turns
          : current.turns,
      messages,
      reasoning,
      tools,
      order,
      outbox: reconcileOutbox(current, payload.messages),
      interactions:
        !older && (interactions.length > 0 || current.hydration !== 'ready')
          ? interactions
          : current.interactions,
      hydration: older ? current.hydration : 'ready',
      historyCursor: payload.nextCursor,
    }
  })
  const restored = next.sessions[thread.sessionId]
  if (!persistedStatus || !restored || next.threads[thread.threadId]?.turns.length !== 0) {
    return next
  }
  return {
    ...next,
    sessions: { ...next.sessions, [thread.sessionId]: { ...restored, status: persistedStatus } },
  }
}

/** The plain text of a message, for matching an echo against what arrived. */
const messageText = (message: Message): string =>
  message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * Drop failed echoes the environment turns out to have accepted. A send whose
 * connection dropped is reported as failed even though its turn may well have
 * started; when an authoritative snapshot or history page then brings back a
 * user message this client never had, that message is the echo. Each arriving
 * message clears at most one echo, so a prompt deliberately sent twice keeps
 * the copy that really did fail.
 */
function reconcileOutbox(current: ThreadState, incoming: readonly Message[]): OutboxEntry[] {
  if (!current.outbox.some((entry) => entry.status === 'failed')) return current.outbox
  const known = new Set(current.messages.map((message) => message.messageId))
  const arrived = incoming
    .filter((message) => message.role === 'user' && !known.has(message.messageId))
    .map(messageText)
  if (arrived.length === 0) return current.outbox
  return current.outbox.filter((entry) => {
    if (entry.status !== 'failed') return true
    const index = arrived.indexOf(entry.text)
    if (index === -1) return true
    arrived.splice(index, 1)
    return false
  })
}

/**
 * The confirmed start of a turn: the real turn and user message replace the
 * echo its command id created. Keyed by ID throughout, so the `turn.send`
 * response and the `turn.started` event may arrive in either order and only
 * the first of them changes anything.
 */
function confirmTurnStart(
  current: ThreadState,
  payload: TurnStarted,
  startedAt?: string,
): ThreadState {
  const outbox = payload.commandId
    ? current.outbox.filter((entry) => entry.commandId !== payload.commandId)
    : current.outbox
  // A delayed send response must not rewind a turn that already progressed.
  // The `turn.started` event's time is when the work began; a `turn.send`
  // response carries none, so whichever arrives second may only fill that in.
  const existing = current.turns.find((turn) => turn.turnId === payload.turn.turnId)
  const turn = existing
    ? existing.startedAt || !startedAt
      ? existing
      : { ...existing, startedAt }
    : { ...payload.turn, ...(startedAt && !payload.turn.startedAt ? { startedAt } : {}) }
  const turns = upsertById(current.turns, (item) => item.turnId, turn)
  // A turn the provider began by itself has no prompt: a background task
  // finished and the agent is acting on the result.
  const { userMessage } = payload
  if (!userMessage) return turns === current.turns ? current : { ...current, turns }
  return {
    ...current,
    turns,
    messages: upsertById(current.messages, (message) => message.messageId, userMessage),
    order: placeActivity(current.order, {
      kind: 'message',
      id: userMessage.messageId,
      turnId: payload.turn.turnId,
    }),
    outbox: outbox.length === current.outbox.length ? current.outbox : outbox,
  }
}

/** Same shape as `turn.started`; used to fold a `turn.send` response in before the event arrives. */
export function applyTurnStarted(
  state: EnvironmentState,
  thread: Thread,
  payload: TurnStart,
): EnvironmentState {
  return patchThread(state, thread, (current) => confirmTurnStart(current, payload))
}

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
  return patchThread(state, thread, (current) => ({
    ...current,
    outbox: upsertById(current.outbox, (item) => item.commandId, entry),
  }))
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

/**
 * A created session, from the command's answer. That answer arrives before the
 * `session.created` event, so it carries the announcement time: without it the
 * session would be listed as the oldest, at the bottom of the sidebar, and move
 * to the top once the event came. With it the event restates what is held.
 */
export function applySessionCreated(
  state: EnvironmentState,
  payload: { session: Session; thread: Thread; announcedAt?: string },
): EnvironmentState {
  const { announcedAt } = payload
  const upserted = upsertSession(state, payload.session, [payload.thread.threadId], announcedAt)
  const withSession = announcedAt
    ? touchWorkspaceActivity(upserted, payload.session.sessionId, announcedAt)
    : upserted
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
  const composerPreferences = { ...state.composerPreferences }
  delete composerPreferences[workspaceId]
  let next: EnvironmentState = {
    ...state,
    workspaces,
    workspaceOrder: state.workspaceOrder.filter((id) => id !== workspaceId),
    composerPreferences,
  }
  for (const session of Object.values(state.sessions)) {
    if (session.workspaceId === workspaceId) next = removeSession(next, session.sessionId)
  }
  return next
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
export function applyComposerPreference(
  state: EnvironmentState,
  target: { workspaceId: string; providerId: string },
  preference: WorkspaceComposerPreference,
): EnvironmentState {
  const workspace = state.composerPreferences[target.workspaceId]
  if (workspace?.[target.providerId] && sameJson(workspace[target.providerId], preference)) {
    return state
  }
  return {
    ...state,
    composerPreferences: {
      ...state.composerPreferences,
      [target.workspaceId]: { ...workspace, [target.providerId]: preference },
    },
  }
}

/** Forget every held preference, so each reads as "not loaded" until asked for again. */
export function applyComposerPreferencesReset(state: EnvironmentState): EnvironmentState {
  return Object.keys(state.composerPreferences).length === 0
    ? state
    : { ...state, composerPreferences: {} }
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

export function applySessionSettled(
  state: EnvironmentState,
  sessionId: string,
  settledAt: string | null,
): EnvironmentState {
  const session = state.sessions[sessionId]
  if (!session || (session.settledAt ?? null) === settledAt) return state
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, settledAt } } }
}

/** The user has looked at a finished session; it stops showing as done. */
export function applySessionAcknowledged(
  state: EnvironmentState,
  sessionId: string,
): EnvironmentState {
  const session = state.sessions[sessionId]
  if (!session || !session.doneAt) return state
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, doneAt: null } } }
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

/**
 * A session being opened. It goes on screen now rather than when
 * `session.open` answers: the threads already known read as loading, and
 * with none known yet the view waits for the first. Leaving the selection
 * empty in between showed the new-session landing for as long as the open
 * took. Opening the session already shown keeps its thread, and a failure
 * stays up while that same session is retried.
 */
export function applySessionOpening(state: EnvironmentState, sessionId: string): EnvironmentState {
  const session = state.sessions[sessionId]
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
    if (session) keyed.push({ session, at: Date.parse(sessionListCursorOf(session).updatedAt) })
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
