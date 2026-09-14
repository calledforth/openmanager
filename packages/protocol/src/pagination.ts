import { PAGE_LIMIT_DEFAULT, type HistoryCursor, type SessionListCursor } from './domains.js'

/**
 * In-memory keyset pagers that mirror the server's SQLite readers, so the
 * proof-slice catalog, the mock client, and the persisted list all page in
 * the same order and hand out interchangeable cursors.
 */

/** A session missing `updatedAt` sorts and pages as if touched at the epoch. */
export const SESSION_LIST_EPOCH = '1970-01-01T00:00:00.000Z'

export interface SessionKeysetItem {
  sessionId: string
  workspaceId: string
  updatedAt?: string
}

export interface SessionPageQuery {
  workspaceId?: string
  cursor?: SessionListCursor
  limit?: number
}

export interface SessionPage<T extends SessionKeysetItem> {
  sessions: T[]
  nextCursor: SessionListCursor | null
}

export interface MessagePageQuery {
  cursor?: HistoryCursor
  limit?: number
}

export interface MessagePage<T> {
  messages: T[]
  nextCursor: HistoryCursor | null
}

export function resolvePageLimit(limit: number | undefined): number {
  return limit ?? PAGE_LIMIT_DEFAULT
}

export function sessionListCursorOf(session: SessionKeysetItem): SessionListCursor {
  return {
    updatedAt: session.updatedAt ?? SESSION_LIST_EPOCH,
    sessionId: session.sessionId,
  }
}

function compareNewestFirst(left: SessionKeysetItem, right: SessionKeysetItem): number {
  const time =
    Date.parse(sessionListCursorOf(right).updatedAt) -
    Date.parse(sessionListCursorOf(left).updatedAt)
  if (time !== 0) return time
  return right.sessionId < left.sessionId ? -1 : right.sessionId > left.sessionId ? 1 : 0
}

function isAfterCursor(session: SessionKeysetItem, cursor: SessionListCursor): boolean {
  const time = Date.parse(sessionListCursorOf(session).updatedAt)
  const cursorTime = Date.parse(cursor.updatedAt)
  return time < cursorTime || (time === cursorTime && session.sessionId < cursor.sessionId)
}

/**
 * Newest-first `(updatedAt, sessionId)` keyset page, optionally scoped to one
 * workspace. Same order and cursor shape as the server's SQLite list.
 */
export function pageSessionSummaries<T extends SessionKeysetItem>(
  sessions: readonly T[],
  query: SessionPageQuery = {},
): SessionPage<T> {
  const limit = resolvePageLimit(query.limit)
  const scoped = query.workspaceId
    ? sessions.filter((session) => session.workspaceId === query.workspaceId)
    : [...sessions]
  const ranked = scoped.sort(compareNewestFirst)
  const cursor = query.cursor
  const after = cursor ? ranked.filter((session) => isAfterCursor(session, cursor)) : ranked
  const page = after.slice(0, limit)
  const last = page.at(-1)
  return {
    sessions: page,
    nextCursor: after.length > limit && last ? sessionListCursorOf(last) : null,
  }
}

/**
 * Newest slice of an in-memory transcript, walking backwards by array index.
 * `nextCursor.ordinal` is the exclusive upper bound for the next older page.
 */
export function pageThreadMessages<T>(
  messages: readonly T[],
  query: MessagePageQuery = {},
): MessagePage<T> {
  const limit = resolvePageLimit(query.limit)
  const end = Math.min(query.cursor ? query.cursor.ordinal : messages.length, messages.length)
  const start = Math.max(0, end - limit)
  return {
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? { ordinal: start } : null,
  }
}
