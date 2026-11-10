import type { DatabaseSync } from 'node:sqlite'
import {
  SEARCH_MESSAGES_CAPABILITY,
  SEARCH_RESULTS_DEFAULT,
  SearchCommandSchemas,
  SearchResponseSchemas,
  type CommandEnvelope,
  type MessageSearchHit,
  type SearchHighlight,
} from '@openmanager/protocol/node'

/** Words past this many are dropped: nobody types more, and each one costs a lookup. */
const MAX_TERMS = 16
/** Tokens of context `snippet()` keeps around the match. */
const SNIPPET_TOKENS = 18
const SNIPPET_MAX_LENGTH = 2048
const HIGHLIGHTS_MAX = 64
const OPEN_MARK = '\u0002'
const CLOSE_MARK = '\u0003'

/**
 * The FTS5 query for what the user typed, or null when it has no words.
 *
 * Every word becomes a quoted prefix term, so all of them must appear (in any
 * order, as mobile's title search already works), each matches the words it
 * starts ("migration" finds "migrations", "pay" finds "payload"), and nothing typed can be read as FTS syntax: `-`,
 * `OR`, `NEAR`, `*`, `:` and parentheses are all just text inside quotes.
 * A word without a letter or digit cannot match anything and is dropped.
 */
export function ftsQueryOf(query: string): string | null {
  const terms = query
    .normalize('NFKC')
    .split(/\s+/)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, MAX_TERMS)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' ')
}

/**
 * A `snippet()` cut with the marker characters, as one line of text and the
 * runs that matched. Line breaks and runs of spaces become one space.
 */
export function snippetOf(marked: string): { snippet: string; highlights: SearchHighlight[] } {
  const line = marked.replace(/\s+/g, ' ').trim()
  let snippet = ''
  const highlights: SearchHighlight[] = []
  let openedAt: number | null = null
  for (const char of line) {
    if (char === OPEN_MARK) {
      openedAt = snippet.length
    } else if (char === CLOSE_MARK) {
      if (openedAt !== null && snippet.length > openedAt && highlights.length < HIGHLIGHTS_MAX) {
        highlights.push([openedAt, snippet.length])
      }
      openedAt = null
    } else {
      snippet += char
    }
  }
  if (snippet.length <= SNIPPET_MAX_LENGTH) return { snippet, highlights }
  // Too long to send whole (one very long word): cut, and keep what still fits.
  const cut = snippet.slice(0, SNIPPET_MAX_LENGTH - 1) + '…'
  return {
    snippet: cut,
    highlights: highlights
      .filter(([start]) => start < SNIPPET_MAX_LENGTH - 1)
      .map(([start, end]) => [start, Math.min(end, SNIPPET_MAX_LENGTH - 1)] as SearchHighlight),
  }
}

type HitRow = {
  session_id: string
  workspace_id: string
  title: string | null
  message_id: string
  role: 'user' | 'assistant'
  created_at: number
  search_rowid: number
  matches: number
}

/**
 * `search.messages`: what was said in this environment's chats, ranked by
 * FTS5's BM25, best message per session. The index is `message_search`
 * (migration 29), filled as each turn ends.
 */
export function createMessageSearch(deps: { database: DatabaseSync }) {
  const { database } = deps
  // Rank every matching message, keep each session's best (ties to the newer
  // message), and count how many of the session's messages matched.
  const hitsQuery = database.prepare(`
    WITH hits AS (
      SELECT rowid AS search_rowid, rank AS score
      FROM message_search WHERE message_search MATCH ?
    ),
    placed AS (
      SELECT th.session_id, t.message_id, h.search_rowid, h.score, m.created_at, m.role,
        row_number() OVER (
          PARTITION BY th.session_id ORDER BY h.score, m.created_at DESC
        ) AS place,
        count(*) OVER (PARTITION BY th.session_id) AS matches
      FROM hits h
      JOIN message_text t ON t.search_rowid = h.search_rowid
      JOIN messages m ON m.message_id = t.message_id
      JOIN threads th ON th.thread_id = m.thread_id
    )
    SELECT p.session_id, s.workspace_id, s.title, p.message_id, p.role, p.created_at,
      p.search_rowid, p.matches
    FROM placed p JOIN sessions s ON s.session_id = p.session_id
    WHERE p.place = 1
    ORDER BY p.score, p.created_at DESC
    LIMIT ?
  `)
  // The CAST matters: node:sqlite binds a JS number as REAL, and FTS5 drops a
  // REAL rowid constraint next to MATCH, answering with the first match.
  const snippetQuery = database.prepare(`
    SELECT snippet(message_search, 0, char(2), char(3), '…', ${SNIPPET_TOKENS}) AS marked
    FROM message_search WHERE message_search MATCH ? AND rowid = CAST(? AS INTEGER)
  `)

  const search = (query: string, limit = SEARCH_RESULTS_DEFAULT): MessageSearchHit[] => {
    const match = ftsQueryOf(query)
    if (match === null) return []
    const rows = hitsQuery.all(match, limit) as HitRow[]
    return rows.map((row) => {
      const marked = snippetQuery.get(match, row.search_rowid) as { marked: string } | undefined
      return {
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        title: row.title,
        messageId: row.message_id,
        role: row.role,
        at: new Date(row.created_at).toISOString(),
        ...snippetOf(marked?.marked ?? ''),
        matches: row.matches,
      }
    })
  }

  return {
    search,

    dispatch(command: CommandEnvelope): Promise<unknown> | undefined {
      if (command.name !== SEARCH_MESSAGES_CAPABILITY) return undefined
      const parsed = SearchCommandSchemas[SEARCH_MESSAGES_CAPABILITY].safeParse(command)
      if (!parsed.success) {
        return Promise.resolve({
          type: 'error' as const,
          requestId: command.requestId,
          error: { code: 'validation' as const, message: 'Invalid search request.' },
        })
      }
      const { query, limit } = parsed.data.payload
      return Promise.resolve(
        SearchResponseSchemas[SEARCH_MESSAGES_CAPABILITY].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { hits: search(query, limit) },
        }),
      )
    },
  }
}
