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
} from '@openmanager/protocol/node'
import {
  INTERACTIONS_FOR_TURN_SQL,
  MESSAGE_HISTORY_PAGE_SQL,
  MESSAGE_PARTS_SQL,
  SESSION_LIST_FOR_ENVIRONMENT_SQL,
  SESSION_LIST_FOR_WORKSPACE_SQL,
  THREADS_FOR_SESSION_SQL,
  TURNS_FOR_THREAD_SQL,
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

export interface SessionHistoryQuery {
  sessionId: string
  threadId: string
  cursor?: HistoryCursor
  limit?: number
}

export interface SessionHistoryPage {
  messages: Message[]
  turns: Turn[]
  interactions: Array<{ threadId: string; interaction: Interaction }>
  nextCursor: HistoryCursor | null
}

type SessionRow = {
  session_id: string
  workspace_id: string
  provider_id: string
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
  const cursor = query.cursor
    ? SessionListCursorSchema.parse(query.cursor)
    : undefined
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
      rows.length > limit && last
        ? { updatedAt: last.updatedAt, sessionId: last.sessionId }
        : null,
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
      `SELECT session_id, workspace_id, provider_id, title, status, updated_at
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined
  return row ? sessionRowToSummary(row) : undefined
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
    .prepare('SELECT thread_id, session_id FROM threads WHERE thread_id = ? AND session_id = ?')
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
  const messages = pageRows
    .map((row) => messageFromRow(database, row))
    .reverse()
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
        interaction: InteractionSchema.parse(JSON.parse(row.request_json)),
      }),
    ),
  )
  const oldest = pageRows.at(-1)
  return {
    messages,
    turns,
    interactions,
    nextCursor:
      rows.length > limit && oldest !== undefined ? { ordinal: oldest.ordinal } : null,
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
