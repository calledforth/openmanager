import type { DatabaseSync } from 'node:sqlite'
import type { Logger } from '../logger.ts'
import { storedListing } from './composer-rows.ts'
import { readSessionActivity } from './session-activity.ts'
import {
  ContentBlockSchema,
  InteractionSchema,
  ReasoningBlockSchema,
  SessionSummarySchema,
  ToolCallStateSchema,
  TurnSchema,
  TURN_FAILURE_MESSAGES,
  type ActivityRef,
  type ComposerListing,
  type Interaction,
  type Message,
  type ReasoningBlock,
  type ToolCallState,
  type SessionStatus,
  type SessionSummary,
  type Thread,
  type Turn,
  type TurnFailureReason,
  type TurnStart,
} from '@openmanager/protocol/node'
import {
  ALL_SESSIONS_SQL,
  INTERACTION_IN_THREAD_SQL,
  MESSAGE_PARTS_FOR_THREAD_SQL,
  MESSAGE_PARTS_SQL,
  MESSAGES_FOR_THREAD_SQL,
  PENDING_INTERACTIONS_FOR_THREAD_SQL,
  THREAD_IN_SESSION_SQL,
  THREAD_LISTING_SQL,
  THREADS_FOR_SESSION_SQL,
  TURN_ACTIVITY_FOR_THREAD_SQL,
  TURN_FOR_COMMAND_ID_SQL,
  TURNS_FOR_THREAD_SQL,
  USER_MESSAGE_FOR_TURN_SQL,
} from './queries.ts'

export interface CommandTurnQuery {
  sessionId: string
  threadId: string
  commandId: string
}

/** A thread as its snapshot states it (docs/sync-foundations.md §6.2): all of it. */
export interface ThreadState {
  thread: Thread
  turns: Turn[]
  messages: Message[]
  reasoning: ReasoningBlock[]
  tools: ToolCallState[]
  /** Every message, reasoning block and tool call, in the order they happened. */
  order: ActivityRef[]
  /** Pending requests, each with the turn it belongs to. */
  interactions: Array<{ turnId: string; interaction: Interaction }>
  /** What the provider offers this chat. */
  listing: ComposerListing
}

type SessionRow = {
  session_id: string
  workspace_id: string
  parent_session_id: string | null
  provider_id: string
  title_source: string | null
  /** 1 while the title is one the title model wrote; see migration 15. */
  title_generated?: number
  title: string | null
  status: string
  composer_json?: string | null
  background_tasks_json?: string | null
  settled_at?: number | null
  done_at?: number | null
  updated_at: number
}

type ThreadRow = { thread_id: string; session_id: string }
type TurnRow = {
  turn_id: string
  thread_id: string
  state: string
  origin?: string | null
  command_id: string | null
  failure_reason: string | null
  failure_message: string | null
  interrupted_by: string | null
  started_at: number
  finished_at: number | null
}

/** A turn as every read states it: history pages, snapshots and a retried send's answer. */
function turnFromRow(row: TurnRow): Turn {
  return TurnSchema.parse({
    turnId: row.turn_id,
    threadId: row.thread_id,
    state: row.state,
    startedAt: new Date(row.started_at).toISOString(),
    ...(row.finished_at === null ? {} : { finishedAt: new Date(row.finished_at).toISOString() }),
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.command_id ? { commandId: row.command_id } : {}),
    // A failure recorded before its message was kept says only its reason.
    ...(row.state === 'failed' && row.failure_reason
      ? {
          failure: {
            reason: row.failure_reason,
            message:
              row.failure_message ??
              TURN_FAILURE_MESSAGES[row.failure_reason as TurnFailureReason] ??
              '',
          },
        }
      : {}),
    ...(row.state === 'interrupted' && row.interrupted_by
      ? { interruptedBy: row.interrupted_by }
      : {}),
  })
}

type TurnActivityRow = {
  activity_id: string
  turn_id: string
  kind: 'reasoning' | 'tool'
  ordinal: number
  state_json: string
}
type MessageRow = {
  message_id: string
  thread_id: string
  turn_id: string
  role: 'user' | 'assistant'
  ordinal: number
}
type PartRow = { content_json: string }
type ThreadPartRow = { message_id: string; content_json: string }
type InteractionRow = {
  turn_id: string
  request_json: string
  state: string
  created_at: number
  resolved_at: number | null
  resolved_by_client_id: string | null
}

function interactionFromRow(row: InteractionRow): Interaction {
  return InteractionSchema.parse({
    ...JSON.parse(row.request_json),
    lifecycle: {
      state: row.state,
      createdAt: new Date(row.created_at).toISOString(),
      resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
      resolvedByClientId: row.resolved_by_client_id,
    },
  })
}

export function sessionRowToSummary(database: DatabaseSync, row: SessionRow): SessionSummary {
  return SessionSummarySchema.parse({
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title,
    ...(row.title_source !== null
      ? { titleSource: row.title_generated === 1 ? 'generated' : row.title_source }
      : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    status: row.status as SessionStatus,
    providerId: row.provider_id,
    updatedAt: new Date(row.updated_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
    doneAt: row.done_at ? new Date(row.done_at).toISOString() : null,
    ...(row.background_tasks_json
      ? { backgroundTasks: JSON.parse(row.background_tasks_json) }
      : {}),
    ...(row.composer_json ? { composer: JSON.parse(row.composer_json) } : {}),
    ...readSessionActivity(database, row),
  })
}

/** Every session, newest first: the environment snapshot's sidebar (§6.2). */
export function listAllSessionSummaries(database: DatabaseSync): SessionSummary[] {
  return (database.prepare(ALL_SESSIONS_SQL).all() as SessionRow[]).map((row) =>
    sessionRowToSummary(database, row),
  )
}

export function listThreadsForSession(database: DatabaseSync, sessionId: string): Thread[] {
  return (database.prepare(THREADS_FOR_SESSION_SQL).all(sessionId) as ThreadRow[]).map((row) => ({
    threadId: row.thread_id,
    sessionId: row.session_id,
  }))
}

export function getSessionSummary(
  database: DatabaseSync,
  sessionId: string,
): SessionSummary | undefined {
  const row = database
    .prepare(
      `SELECT session_id, workspace_id, parent_session_id, provider_id, title, title_source, title_generated, status,
              composer_json, background_tasks_json, settled_at, done_at, updated_at
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined
  return row ? sessionRowToSummary(database, row) : undefined
}

/**
 * The host session already registered for a provider's own session id, if
 * any. Child sessions are registered from provider subtask events, which
 * repeat across turns and reconnects, so registration must find its earlier
 * self instead of filing a second host session for the same provider thread.
 */
export function findSessionIdByProviderSession(
  database: DatabaseSync,
  providerId: string,
  providerSessionId: string,
): string | undefined {
  const row = database
    .prepare('SELECT session_id FROM sessions WHERE provider_id = ? AND provider_session_id = ?')
    .get(providerId, providerSessionId) as { session_id: string } | undefined
  return row?.session_id
}

/**
 * The provider's own session id, stored when the runtime session first
 * resolved. Resuming needs it to load the provider thread instead of
 * creating a second one for the same session.
 */
export function getProviderSessionId(
  database: DatabaseSync,
  sessionId: string,
): string | undefined {
  const row = database
    .prepare('SELECT provider_session_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { provider_session_id: string | null } | undefined
  return row?.provider_session_id ?? undefined
}

/**
 * The whole thread, as its snapshot carries it: every turn, message,
 * reasoning block (uncapped) and tool call, their order by the thread-wide
 * ordinal both tables draw from, and the pending requests with their turn.
 * One query per table, whatever the thread's length.
 */
export function readThreadState(
  database: DatabaseSync,
  query: { sessionId: string; threadId: string },
  log?: Logger,
): ThreadState | undefined {
  const thread = database.prepare(THREAD_IN_SESSION_SQL).get(query.threadId, query.sessionId) as
    ThreadRow | undefined
  if (!thread) return undefined
  const turns = (database.prepare(TURNS_FOR_THREAD_SQL).all(query.threadId) as TurnRow[]).map(
    turnFromRow,
  )
  const messageRows = database.prepare(MESSAGES_FOR_THREAD_SQL).all(query.threadId) as MessageRow[]
  const parts = new Map<string, Message['content']>()
  for (const row of database
    .prepare(MESSAGE_PARTS_FOR_THREAD_SQL)
    .all(query.threadId) as ThreadPartRow[]) {
    let content = parts.get(row.message_id)
    if (!content) parts.set(row.message_id, (content = []))
    content.push(ContentBlockSchema.parse(JSON.parse(row.content_json)))
  }
  const messages = messageRows.map((row) => ({
    messageId: row.message_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role,
    content: parts.get(row.message_id) ?? [],
  }))
  const activityRows = database
    .prepare(TURN_ACTIVITY_FOR_THREAD_SQL)
    .all(query.threadId) as TurnActivityRow[]
  const reasoning: ReasoningBlock[] = []
  const tools: ToolCallState[] = []
  for (const row of activityRows) {
    const state: unknown = JSON.parse(row.state_json)
    if (row.kind === 'reasoning') reasoning.push(ReasoningBlockSchema.parse(state))
    else tools.push(ToolCallStateSchema.parse(state))
  }
  // Both lists are in ordinal order already: merge them.
  const order: ActivityRef[] = []
  let message = 0
  let activity = 0
  while (message < messageRows.length || activity < activityRows.length) {
    const nextMessage = messageRows[message]
    const nextActivity = activityRows[activity]
    if (nextMessage && (!nextActivity || nextMessage.ordinal < nextActivity.ordinal)) {
      order.push({ kind: 'message', id: nextMessage.message_id, turnId: nextMessage.turn_id })
      message += 1
    } else if (nextActivity) {
      order.push({
        kind: nextActivity.kind,
        id: nextActivity.activity_id,
        turnId: nextActivity.turn_id,
      })
      activity += 1
    }
  }
  const interactions = (
    database.prepare(PENDING_INTERACTIONS_FOR_THREAD_SQL).all(query.threadId) as InteractionRow[]
  ).map((row) => ({ turnId: row.turn_id, interaction: interactionFromRow(row) }))
  return {
    thread: { threadId: thread.thread_id, sessionId: thread.session_id },
    turns,
    messages,
    reasoning,
    tools,
    order,
    interactions,
    listing: readThreadListing(database, query.threadId, log) ?? {},
  }
}

/** What the provider last listed for this chat, if the thread exists and it has. */
export function readThreadListing(
  database: DatabaseSync,
  threadId: string,
  log?: Logger,
): ComposerListing | undefined {
  const row = database.prepare(THREAD_LISTING_SQL).get(threadId) as
    { listing_json: string | null } | undefined
  return row?.listing_json
    ? storedListing(JSON.parse(row.listing_json), { threadId }, log)
    : undefined
}

function messageFromRow(database: DatabaseSync, row: MessageRow): Message {
  const parts = database.prepare(MESSAGE_PARTS_SQL).all(row.message_id) as PartRow[]
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    role: row.role,
    content: parts.map((part) => ContentBlockSchema.parse(JSON.parse(part.content_json))),
  }
}

/**
 * Whether the log holds this interaction for the thread. One that memory has
 * forgotten — a restart ends every turn — can only be settled by now.
 */
export function hasInteraction(
  database: DatabaseSync,
  query: { sessionId: string; threadId: string; interactionId: string },
): boolean {
  return !!database
    .prepare(INTERACTION_IN_THREAD_SQL)
    .get(query.interactionId, query.threadId, query.sessionId)
}

/** The requests of a turn its rows say were cancelled (by its end, or a restart). */
export function cancelledInteractionIds(database: DatabaseSync, turnId: string): Set<string> {
  const rows = database
    .prepare("SELECT interaction_id FROM interactions WHERE turn_id = ? AND state = 'cancelled'")
    .all(turnId) as { interaction_id: string }[]
  return new Set(rows.map((row) => row.interaction_id))
}

/**
 * The turn a thread of this session still holds open in its rows, if any.
 * After a boot whose recovery of that turn failed (db/boot-reconcile.ts),
 * the rows hold an open turn no process is running.
 */
export function findOpenTurnId(
  database: DatabaseSync,
  query: { sessionId: string; threadId: string },
): string | undefined {
  const row = database
    .prepare(
      `SELECT turns.turn_id FROM turns JOIN threads ON threads.thread_id = turns.thread_id
       WHERE turns.thread_id = ? AND threads.session_id = ? AND turns.state IN ('running', 'waiting')
       LIMIT 1`,
    )
    .get(query.threadId, query.sessionId) as { turn_id: string } | undefined
  return row?.turn_id
}

/**
 * The turn a command id already started in this thread, with the prompt it
 * recorded. A retry of that id answers with this turn rather than starting a
 * second one, including after a restart when nothing is left in memory.
 */
export function findTurnByCommandId(
  database: DatabaseSync,
  query: CommandTurnQuery,
): TurnStart | undefined {
  const thread = database.prepare(THREAD_IN_SESSION_SQL).get(query.threadId, query.sessionId) as
    ThreadRow | undefined
  if (!thread) return undefined
  const turn = database.prepare(TURN_FOR_COMMAND_ID_SQL).get(query.threadId, query.commandId) as
    TurnRow | undefined
  if (!turn) return undefined
  const message = database.prepare(USER_MESSAGE_FOR_TURN_SQL).get(turn.turn_id) as
    MessageRow | undefined
  if (!message) return undefined
  return {
    turn: turnFromRow(turn),
    userMessage: messageFromRow(database, message),
    commandId: query.commandId,
  }
}
