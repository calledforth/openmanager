import type { DatabaseSync } from 'node:sqlite'
import {
  ContentBlockSchema,
  HistoryCursorSchema,
  InteractionSchema,
  SessionListCursorSchema,
  SessionSummarySchema,
  TurnSchema,
  resolvePageLimit,
  type HistoryCursor,
  type Interaction,
  type Message,
  type SessionListCursor,
  type SessionStatus,
  type SessionSummary,
  type Thread,
  type Turn,
  type TurnStart,
} from '@openmanager/protocol/node'
import {
  INTERACTIONS_FOR_TURN_SQL,
  MESSAGE_HISTORY_PAGE_SQL,
  MESSAGE_PARTS_SQL,
  SESSION_LIST_FOR_ENVIRONMENT_SQL,
  SESSION_LIST_FOR_WORKSPACE_SQL,
  THREAD_IN_SESSION_SQL,
  THREADS_FOR_SESSION_SQL,
  TURN_FOR_COMMAND_ID_SQL,
  TURNS_FOR_THREAD_SQL,
  USER_MESSAGE_FOR_TURN_SQL,
} from './queries.ts'

export interface SessionListQuery {
  workspaceId?: string
  cursor?: SessionListCursor
  limit?: number
}

export interface SessionListPage {
  sessions: SessionSummary[]
  nextCursor: SessionListCursor | null
}

export interface CommandTurnQuery {
  sessionId: string
  threadId: string
  commandId: string
}

export interface SessionHistoryQuery {
  sessionId: string
  threadId: string
  cursor?: HistoryCursor
  limit?: number
}

export interface SessionHistoryPage {
  messages: Message[]
  turns: Turn[]
  /** `turnId` is server-side detail for snapshots; the history response schema drops it. */
  interactions: Array<{ threadId: string; turnId: string; interaction: Interaction }>
  nextCursor: HistoryCursor | null
}

type SessionRow = {
  session_id: string
  workspace_id: string
  parent_session_id: string | null
  provider_id: string
  title_source: string | null
  title: string | null
  status: string
  updated_at: number
}

type ThreadRow = { thread_id: string; session_id: string }
type TurnRow = { turn_id: string; thread_id: string; state: string }
type MessageRow = {
  message_id: string
  thread_id: string
  turn_id: string
  role: 'user' | 'assistant'
  ordinal: number
}
type PartRow = { content_json: string }
type InteractionRow = { turn_id: string; request_json: string }

const FIRST_LIST_CURSOR = {
  updatedAtMs: Number.MAX_SAFE_INTEGER,
  sessionId: '\uffff',
} as const
const FIRST_HISTORY_ORDINAL = Number.MAX_SAFE_INTEGER

export function sessionRowToSummary(row: SessionRow): SessionSummary {
  return SessionSummarySchema.parse({
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title,
    ...(row.title_source !== null ? { titleSource: row.title_source } : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    status: row.status as SessionStatus,
    providerId: row.provider_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  })
}

/**
 * Newest-first keyset page over the environment or one workspace. Fetches
 * `limit + 1` so `nextCursor` is exact without counting the table.
 */
export function listSessionSummaries(
  database: DatabaseSync,
  query: SessionListQuery = {},
): SessionListPage {
  const limit = resolvePageLimit(query.limit)
  const cursor = query.cursor ? SessionListCursorSchema.parse(query.cursor) : undefined
  const updatedAtMs = cursor ? Date.parse(cursor.updatedAt) : FIRST_LIST_CURSOR.updatedAtMs
  const sessionId = cursor?.sessionId ?? FIRST_LIST_CURSOR.sessionId
  const rows = (
    query.workspaceId
      ? database
          .prepare(SESSION_LIST_FOR_WORKSPACE_SQL)
          .all(query.workspaceId, updatedAtMs, sessionId, limit + 1)
      : database.prepare(SESSION_LIST_FOR_ENVIRONMENT_SQL).all(updatedAtMs, sessionId, limit + 1)
  ) as SessionRow[]
  const page = rows.slice(0, limit).map(sessionRowToSummary)
  const last = page.at(-1)
  return {
    sessions: page,
    nextCursor:
      rows.length > limit && last ? { updatedAt: last.updatedAt, sessionId: last.sessionId } : null,
  }
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
      `SELECT session_id, workspace_id, parent_session_id, provider_id, title, title_source, status, updated_at
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined
  return row ? sessionRowToSummary(row) : undefined
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
 * One newest-first page of a thread's messages, with parts, turns, and
 * pending interactions hydrated. `nextCursor.ordinal` is the oldest ordinal
 * on this page — the exclusive bound for the next older page.
 */
export function listSessionHistory(
  database: DatabaseSync,
  query: SessionHistoryQuery,
): SessionHistoryPage | undefined {
  const thread = database
    .prepare(THREAD_IN_SESSION_SQL)
    .get(query.threadId, query.sessionId) as ThreadRow | undefined
  if (!thread) return undefined

  const limit = resolvePageLimit(query.limit)
  const ordinal = query.cursor
    ? HistoryCursorSchema.parse(query.cursor).ordinal
    : FIRST_HISTORY_ORDINAL
  const rows = database
    .prepare(MESSAGE_HISTORY_PAGE_SQL)
    .all(query.threadId, ordinal, limit + 1) as MessageRow[]
  const pageRows = rows.slice(0, limit)
  const messages = pageRows.map((row) => messageFromRow(database, row)).reverse()
  const turns = (database.prepare(TURNS_FOR_THREAD_SQL).all(query.threadId) as TurnRow[]).map(
    (row) =>
      TurnSchema.parse({
        turnId: row.turn_id,
        threadId: row.thread_id,
        state: row.state,
      }),
  )
  const interactions = turns.flatMap((turn) =>
    (database.prepare(INTERACTIONS_FOR_TURN_SQL).all(turn.turnId) as InteractionRow[]).map(
      (row) => ({
        threadId: query.threadId,
        turnId: turn.turnId,
        interaction: InteractionSchema.parse(JSON.parse(row.request_json)),
      }),
    ),
  )
  const oldest = pageRows.at(-1)
  return {
    messages,
    turns,
    interactions,
    nextCursor: rows.length > limit && oldest !== undefined ? { ordinal: oldest.ordinal } : null,
  }
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
 * The turn a command id already started in this thread, with the prompt it
 * recorded. A retry of that id answers with this turn rather than starting a
 * second one, including after a restart when nothing is left in memory.
 */
export function findTurnByCommandId(
  database: DatabaseSync,
  query: CommandTurnQuery,
): TurnStart | undefined {
  const thread = database
    .prepare(THREAD_IN_SESSION_SQL)
    .get(query.threadId, query.sessionId) as ThreadRow | undefined
  if (!thread) return undefined
  const turn = database.prepare(TURN_FOR_COMMAND_ID_SQL).get(query.threadId, query.commandId) as
    | TurnRow
    | undefined
  if (!turn) return undefined
  const message = database.prepare(USER_MESSAGE_FOR_TURN_SQL).get(turn.turn_id) as
    | MessageRow
    | undefined
  if (!message) return undefined
  return {
    turn: TurnSchema.parse({ turnId: turn.turn_id, threadId: turn.thread_id, state: turn.state }),
    userMessage: messageFromRow(database, message),
    commandId: query.commandId,
  }
}
