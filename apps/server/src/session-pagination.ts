import { Buffer } from 'node:buffer'
import {
  pageSessionSummaries as pageByRowLimit,
  sessionListCursorOf,
  type SessionPage,
  type SessionPageQuery,
  type SessionSummary,
} from '@openmanager/protocol/node'

// Leave room below the socket's 1 MiB limit for envelopes and snapshot metadata.
export const SESSION_PAGE_BYTE_BUDGET = 256 * 1024

export function budgetSessionPage<T extends SessionSummary>(page: SessionPage<T>): SessionPage<T> {
  let bytes = 2 // JSON array brackets.
  let count = 0
  for (const session of page.sessions) {
    // Count UTF-8 bytes plus commas; together with the brackets this is the
    // exact serialized array size without repeatedly stringifying its prefix.
    const added = Buffer.byteLength(JSON.stringify(session), 'utf8') + (count > 0 ? 1 : 0)
    // Always make progress, even when one summary exceeds the entire budget.
    if (count > 0 && bytes + added > SESSION_PAGE_BYTE_BUDGET) break
    bytes += added
    count++
  }
  if (count === page.sessions.length) return page
  const sessions = page.sessions.slice(0, count)
  return { sessions, nextCursor: sessionListCursorOf(sessions[count - 1]!) }
}

export function pageSessionSummaries(
  sessions: readonly SessionSummary[],
  query: SessionPageQuery = {},
): SessionPage<SessionSummary> {
  return budgetSessionPage(pageByRowLimit(sessions, query))
}
