import type { HistoryCursor, Message } from '@openmanager/protocol'
import {
  PAGE_LIMIT_MAX,
  pageSessionSummaries as pageSummaries,
  pageThreadMessages as pageMessages,
  resolvePageLimit as resolveLimit,
} from '@openmanager/protocol'
import { EnvironmentClientError } from './errors'
import type {
  ListSessionsInput,
  SessionHistoryPage,
  SessionListPage,
  SessionSummary,
} from './types'

export { sessionListCursorOf } from '@openmanager/protocol'

/**
 * The shared protocol pagers trust their input; the mock client validates the
 * limit here so an out-of-range value surfaces as a client validation error.
 */
export function resolvePageLimit(limit?: number): number {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX)) {
    throw new EnvironmentClientError('validation', `limit must be between 1 and ${PAGE_LIMIT_MAX}.`)
  }
  return resolveLimit(limit)
}

/** Newest-first keyset page. Same order as the server SQLite list. */
export function pageSessionSummaries(
  sessions: readonly SessionSummary[],
  query: ListSessionsInput = {},
): SessionListPage {
  return pageSummaries(sessions, { ...query, limit: resolvePageLimit(query.limit) })
}

/** Newest slice of an in-memory transcript, walking backwards by array index. */
export function pageThreadMessages(
  messages: readonly Message[],
  query: { cursor?: HistoryCursor; limit?: number } = {},
): Pick<SessionHistoryPage, 'messages' | 'nextCursor'> {
  return pageMessages(messages, { ...query, limit: resolvePageLimit(query.limit) })
}
