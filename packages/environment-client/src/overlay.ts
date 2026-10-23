import type {
  SessionSummary as ProtocolSessionSummary,
  Thread,
  TurnStart,
  WorkspaceComposerPreference,
} from '@openmanager/protocol'
import type { EnvironmentState, SessionSummary, ThreadState } from './types'
import { createThreadState, provisionalThread, withSessionUpserted } from './state'

/**
 * The user's own unconfirmed actions (docs/sync-foundations.md §3.2). The
 * overlay is client-owned state beside the server's: it never writes into
 * server-owned state, and server state never needs to know about it. What a
 * reader sees is the two composed (`composeView`), so a click shows at once
 * and the screen falls back to the server's last word when the command fails.
 *
 * Each entry goes when the server's state shows what it asked for (`prune`,
 * after every update), or when its command fails. A send's overlay is the
 * thread's `outbox`, which predates this one and is client-owned too.
 */
export interface PendingOverlay {
  /** A created session, from its answer, until server state lists it and its chat loads. */
  creates: Record<string, PendingCreate>
  /** A requested title, until server state has it or a newer one. */
  renames: Record<string, PendingRename>
  /** An answered prompt, hidden until server state no longer lists it. */
  answers: Record<string, PendingAnswer>
  /** A requested settled or active placement; the latest click wins. */
  settles: Record<string, PendingSettle>
  /** An acknowledged result, shown as not done until server state agrees. */
  acks: Record<string, PendingTicket>
  /** A session or workspace being removed, hidden until server state no longer has it. */
  removals: Record<string, PendingRemoval>
  /** Requested composer picks, by `workspaceId:providerId`, oldest first. */
  preferences: Record<string, PendingPreference[]>
}

export interface PendingTicket {
  ticket: number
}

export interface PendingCreate {
  session: ProtocolSessionSummary
  thread: Thread
  /** The first turn the answer reported, shown until the chat itself has it. */
  firstTurn?: TurnStart
  /** Server state has listed the session; once it no longer does, it was deleted. */
  listed?: true
}

export interface PendingRename extends PendingTicket {
  title: string | null
  /** The title server state held when the rename was asked for. */
  from: string | null
}

export interface PendingAnswer {
  threadId: string
}

export interface PendingSettle extends PendingTicket {
  settled: boolean
  /**
   * Its command is unanswered. The entry stays even where server state
   * already agrees: an earlier click's echo may still arrive and must not
   * move the session under the pointer.
   */
  inFlight?: true
  /** Shown as the settling time until the server's own arrives. */
  at: string
}

export interface PendingRemoval extends PendingTicket {
  kind: 'session' | 'workspace'
}

export interface PendingPreference extends PendingTicket {
  workspaceId: string
  providerId: string
  /** What was asked for: a patch over whatever the server holds. */
  patch: WorkspaceComposerPreference
  /** The workspace was listed when this was asked for, so its removal takes this too. */
  listed?: true
  /** Once acknowledged: the revision the change produced, and the preference it left. */
  acknowledged?: { revision: number; preference: WorkspaceComposerPreference }
}

export function emptyOverlay(): PendingOverlay {
  return {
    creates: {},
    renames: {},
    answers: {},
    settles: {},
    acks: {},
    removals: {},
    preferences: {},
  }
}

export const preferenceKey = (target: { workspaceId: string; providerId: string }) =>
  `${target.workspaceId}:${target.providerId}`

const isEmpty = (overlay: PendingOverlay | undefined) =>
  !overlay || Object.values(overlay).every((entries) => Object.keys(entries).length === 0)

/** Change one overlay table; the state is returned unchanged when the table is. */
export function updateOverlay<K extends keyof PendingOverlay>(
  state: EnvironmentState,
  table: K,
  change: (entries: PendingOverlay[K]) => PendingOverlay[K],
): EnvironmentState {
  const overlay = state.pending ?? emptyOverlay()
  const entries = change(overlay[table])
  return entries === overlay[table]
    ? state
    : { ...state, pending: { ...overlay, [table]: entries } }
}

/** Remove one entry, only if it is still the one `ticket` names (the latest request wins). */
export function dropOverlayEntry<K extends Exclude<keyof PendingOverlay, 'preferences'>>(
  state: EnvironmentState,
  table: K,
  id: string,
  ticket?: number,
): EnvironmentState {
  return updateOverlay(state, table, (entries) => {
    const entry = (entries as Record<string, Partial<PendingTicket>>)[id]
    if (!entry || (ticket !== undefined && entry.ticket !== ticket)) return entries
    const next = { ...entries }
    delete (next as Record<string, unknown>)[id]
    return next
  })
}

/** A settle's command was answered: from now on server state agreeing ends it. */
export function settleAnswered(state: EnvironmentState, sessionId: string, ticket: number) {
  return updateOverlay(state, 'settles', (entries) => {
    const entry = entries[sessionId]
    if (!entry || entry.ticket !== ticket || !entry.inFlight) return entries
    const answered = { ...entry }
    delete answered.inFlight
    return { ...entries, [sessionId]: answered }
  })
}

export function dropPreferenceRequest(state: EnvironmentState, key: string, ticket: number) {
  return updateOverlay(state, 'preferences', (entries) => {
    const requests = entries[key]
    if (!requests?.some((item) => item.ticket === ticket)) return entries
    const left = requests.filter((item) => item.ticket !== ticket)
    const next = { ...entries }
    if (left.length) next[key] = left
    else delete next[key]
    return next
  })
}

const revisionOf = (state: EnvironmentState, target: { workspaceId: string; providerId: string }) =>
  state.composerRevisions?.[target.workspaceId]?.[target.providerId]

const settledMatches = (settledAt: string | null | undefined, settled: boolean) =>
  settled === (settledAt !== null && settledAt !== undefined)

/**
 * Forget what server state now shows. Run after every update (store.ts), so
 * an entry never outlives what it was waiting for.
 */
export function pruneOverlay(state: EnvironmentState): EnvironmentState {
  const overlay = state.pending
  if (isEmpty(overlay)) return state
  let next = state
  for (const [sessionId, entry] of Object.entries(overlay!.creates)) {
    const listed = state.sessions[sessionId] !== undefined
    const thread = state.threads[entry.thread.threadId]
    const loaded =
      thread?.hydration === 'ready' &&
      (!entry.firstTurn ||
        thread.turns.some((turn) => turn.turnId === entry.firstTurn!.turn.turnId))
    if ((entry.listed && !listed) || (listed && (loaded || state.activeSessionId !== sessionId))) {
      next = dropOverlayEntry(next, 'creates', sessionId)
    } else if (listed && !entry.listed) {
      next = updateOverlay(next, 'creates', (entries) => ({
        ...entries,
        [sessionId]: { ...entry, listed: true },
      }))
    }
  }
  for (const [sessionId, entry] of Object.entries(overlay!.renames)) {
    const title = state.sessions[sessionId]?.title ?? null
    if (!state.sessions[sessionId] || title === entry.title || title !== entry.from) {
      next = dropOverlayEntry(next, 'renames', sessionId)
    }
  }
  for (const [interactionId, entry] of Object.entries(overlay!.answers)) {
    const pending = state.threads[entry.threadId]?.interactions.some(
      (item) => item.interaction.interactionId === interactionId,
    )
    if (!pending) next = dropOverlayEntry(next, 'answers', interactionId)
  }
  for (const [sessionId, entry] of Object.entries(overlay!.settles)) {
    const session = state.sessions[sessionId]
    if (!session || (!entry.inFlight && settledMatches(session.settledAt, entry.settled))) {
      next = dropOverlayEntry(next, 'settles', sessionId)
    }
  }
  for (const sessionId of Object.keys(overlay!.acks)) {
    const session = state.sessions[sessionId]
    if (!session || !session.doneAt) next = dropOverlayEntry(next, 'acks', sessionId)
  }
  for (const [id, entry] of Object.entries(overlay!.removals)) {
    const present = entry.kind === 'session' ? state.sessions[id] : state.workspaces[id]
    if (!present) next = dropOverlayEntry(next, 'removals', id)
  }
  for (const [key, requests] of Object.entries(overlay!.preferences)) {
    const first = requests[0]!
    const held = revisionOf(state, first)
    const left = requests.filter(
      (item) =>
        !(item.listed && state.workspaces[item.workspaceId] === undefined) &&
        !(item.acknowledged && held !== undefined && held >= item.acknowledged.revision),
    )
    if (left.length !== requests.length) {
      next = updateOverlay(next, 'preferences', (entries) => {
        const copy = { ...entries }
        if (left.length) copy[key] = left
        else delete copy[key]
        return copy
      })
    }
  }
  return next
}

const composed = new WeakMap<EnvironmentState, EnvironmentState>()

/**
 * Server state with the user's unconfirmed actions laid over it, for display.
 * The same object as long as nothing is pending, and one object per server
 * state otherwise, so readers keep their structural sharing.
 */
export function composeView(state: EnvironmentState): EnvironmentState {
  const overlay = state.pending
  if (isEmpty(overlay)) return state
  const cached = composed.get(state)
  if (cached) return cached
  let view = state
  const patchSession = (sessionId: string, change: (session: SessionSummary) => SessionSummary) => {
    const session = view.sessions[sessionId]
    if (!session) return
    view = { ...view, sessions: { ...view.sessions, [sessionId]: change(session) } }
  }

  for (const [sessionId, entry] of Object.entries(overlay!.creates)) {
    if (!entry.listed && !view.sessions[sessionId]) {
      view = withSessionUpserted(view, entry.session, [entry.thread.threadId])
    }
    const thread = view.threads[entry.thread.threadId]
    if (thread?.hydration !== 'ready' || (entry.firstTurn && !holdsTurn(thread, entry.firstTurn))) {
      view = {
        ...view,
        threads: {
          ...view.threads,
          [entry.thread.threadId]: entry.firstTurn
            ? provisionalThread(entry.thread, entry.firstTurn, thread)
            : (thread ?? createThreadState(entry.thread, 'ready')),
        },
      }
    }
  }
  for (const [sessionId, entry] of Object.entries(overlay!.renames)) {
    patchSession(sessionId, (session) => ({ ...session, title: entry.title, titleSource: 'user' }))
  }
  for (const [sessionId, entry] of Object.entries(overlay!.settles)) {
    patchSession(sessionId, (session) =>
      settledMatches(session.settledAt, entry.settled)
        ? session
        : { ...session, settledAt: entry.settled ? entry.at : null },
    )
  }
  for (const sessionId of Object.keys(overlay!.acks)) {
    patchSession(sessionId, (session) => (session.doneAt ? { ...session, doneAt: null } : session))
  }
  const answered = Object.entries(overlay!.answers)
  if (answered.length) {
    const threads = { ...view.threads }
    for (const [interactionId, entry] of answered) {
      const thread = threads[entry.threadId]
      if (!thread) continue
      threads[entry.threadId] = {
        ...thread,
        interactions: thread.interactions.filter(
          (item) => item.interaction.interactionId !== interactionId,
        ),
      }
    }
    view = { ...view, threads }
  }
  const removals = Object.entries(overlay!.removals)
  if (removals.length) {
    const sessions = { ...view.sessions }
    const workspaces = { ...view.workspaces }
    for (const [id, entry] of removals) {
      if (entry.kind === 'session') delete sessions[id]
      else delete workspaces[id]
    }
    view = {
      ...view,
      sessions,
      sessionOrder: view.sessionOrder.filter((id) => sessions[id] !== undefined),
      workspaces,
      workspaceOrder: view.workspaceOrder.filter((id) => workspaces[id] !== undefined),
    }
  }
  const preferences = Object.values(overlay!.preferences)
  if (preferences.length) {
    const byWorkspace = { ...view.composerPreferences }
    for (const requests of preferences) {
      const { workspaceId, providerId } = requests[0]!
      // The newest acknowledged state, by the server's revision, not by
      // arrival; then what is still asked for, in the order it was asked.
      const newest = requests
        .filter((request) => request.acknowledged)
        .sort((a, b) => a.acknowledged!.revision - b.acknowledged!.revision)
        .at(-1)
      let shown = newest?.acknowledged!.preference ?? byWorkspace[workspaceId]?.[providerId]
      for (const request of requests) {
        if (!request.acknowledged) shown = { ...shown, ...request.patch }
      }
      if (shown) {
        byWorkspace[workspaceId] = { ...byWorkspace[workspaceId], [providerId]: shown }
      }
    }
    view = { ...view, composerPreferences: byWorkspace }
  }
  composed.set(state, view)
  return view
}

const holdsTurn = (thread: ThreadState, firstTurn: TurnStart) =>
  thread.turns.some((turn) => turn.turnId === firstTurn.turn.turnId)
