import type { HistoryCursor, Message } from '@openmanager/protocol'
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@openmanager/protocol'
import { EnvironmentClientError } from './errors'
import type { ListSessionsInput, SessionHistoryPage, SessionListPage, SessionSummary } from './types'

const FALLBACK_UPDATED_AT = '1970-01-01T00:00:00.000Z'

export function resolvePageLimit(limit?: number): number {
  if (limit === undefined) return PAGE_LIMIT_DEFAULT
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
    throw new EnvironmentClientError('validation', 'limit must be between 1 and 100.')
  }
  return limit
}

export function sessionListCursorOf(session: SessionSummary): {
  updatedAt: string
  sessionId: string
} {
  return {
    updatedAt: session.updatedAt ?? FALLBACK_UPDATED_AT,
    sessionId: session.sessionId,
  }
}

/** Newest-first keyset page. Same order as the server SQLite list. */
export function pageSessionSummaries(
  sessions: readonly SessionSummary[],
  query: ListSessionsInput = {},
): SessionListPage {
  const limit = resolvePageLimit(query.limit)
  const scoped = query.workspaceId
    ? sessions.filter((session) => session.workspaceId === query.workspaceId)
    : [...sessions]
  const ranked = [...scoped].sort((left, right) => {
    const time =
      Date.parse(sessionListCursorOf(right).updatedAt) -
      Date.parse(sessionListCursorOf(left).updatedAt)
    if (time !== 0) return time
    const leftId = sessionListCursorOf(left).sessionId
    const rightId = sessionListCursorOf(right).sessionId
    return rightId < leftId ? -1 : rightId > leftId ? 1 : 0
  })
  const after = query.cursor
    ? ranked.filter((session) => {
        const { updatedAt, sessionId } = sessionListCursorOf(session)
        const time = Date.parse(updatedAt)
        const cursorTime = Date.parse(query.cursor!.updatedAt)
        return time < cursorTime || (time === cursorTime && sessionId < query.cursor!.sessionId)
      })
    : ranked
  const page = after.slice(0, limit)
  const last = page.at(-1)
  return {
    sessions: page,
    nextCursor:
      after.length > limit && last
        ? sessionListCursorOf(last)
        : null,
  }
}

/** Newest slice of an in-memory transcript, walking backwards by array index. */
export function pageThreadMessages(
  messages: readonly Message[],
  query: { cursor?: HistoryCursor; limit?: number } = {},
): Pick<SessionHistoryPage, 'messages' | 'nextCursor'> {
  const limit = resolvePageLimit(query.limit)
  const end = query.cursor ? query.cursor.ordinal : messages.length
  const start = Math.max(0, Math.min(end, messages.length) - limit)
  return {
    messages: messages.slice(start, Math.min(end, messages.length)),
    nextCursor: start > 0 ? { ordinal: start } : null,
  }
}
