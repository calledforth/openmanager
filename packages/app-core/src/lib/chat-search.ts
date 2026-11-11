import { useEffect, useRef, useState } from 'react'
import type { MessageSearchHit, SearchHighlight } from '@openmanager/protocol'

/** Typing settles for this long before the environments are asked. */
export const CHAT_SEARCH_DEBOUNCE_MS = 200
/** An environment that has not answered by then is left out of this query. */
export const CHAT_SEARCH_TIMEOUT_MS = 3_000
export const CHAT_SEARCH_LIMIT = 20

/** A hit, and the environment it came from. */
export interface PlacedSearchHit extends MessageSearchHit {
  environmentId: string
}

/** One environment's answer: its own hits, best first. */
export interface EnvironmentSearchHits {
  environmentId: string
  hits: readonly MessageSearchHit[]
}

/** Something that can be searched: one connected environment. */
export interface ChatSearchSource {
  environmentId: string
  search: (query: string, limit: number) => Promise<readonly MessageSearchHit[]>
}

/** The words of a query, as title search compares them: lower case, no blanks. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Every word appears somewhere in the haystacks, in any order. No words matches nothing. */
export function matchesWords(
  words: readonly string[],
  ...haystacks: ReadonlyArray<string | null | undefined>
): boolean {
  if (words.length === 0) return false
  const text = haystacks
    .filter((h): h is string => typeof h === 'string')
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * One list from every environment's, by position. Each environment ranks by
 * its own measure (BM25 over its own chats), and those scores do not compare
 * across environments, so the merge never reads them: every environment's
 * first hit comes before anyone's second, and so on. Within one place the
 * newer message goes first; equal times keep the environments' order.
 */
export function mergeSearchHits(answers: readonly EnvironmentSearchHits[]): PlacedSearchHit[] {
  const merged: PlacedSearchHit[] = []
  const depth = Math.max(0, ...answers.map((answer) => answer.hits.length))
  for (let place = 0; place < depth; place += 1) {
    const tier: PlacedSearchHit[] = []
    for (const answer of answers) {
      const hit = answer.hits[place]
      if (hit) tier.push({ ...hit, environmentId: answer.environmentId })
    }
    tier.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    merged.push(...tier)
  }
  return merged
}

/** A hit's snippet, ready to show: its text and the runs that matched in it. */
export interface SearchSnippet {
  text: string
  highlights: readonly SearchHighlight[]
}

/**
 * The snippet without the "…" SQLite puts before a match that is not at the
 * start of its message. At the head of a line it reads as noise, where the
 * trailing one still says the message goes on; the highlight offsets shift
 * with the cut.
 */
export function withoutLeadingEllipsis(
  hit: Pick<MessageSearchHit, 'snippet' | 'highlights'>,
): SearchSnippet {
  const cut = hit.snippet.startsWith('… ') ? 2 : hit.snippet.startsWith('…') ? 1 : 0
  if (cut === 0) return { text: hit.snippet, highlights: hit.highlights }
  return {
    text: hit.snippet.slice(cut),
    highlights: hit.highlights.flatMap(([start, end]) =>
      end <= cut ? [] : [[Math.max(0, start - cut), end - cut] as SearchHighlight],
    ),
  }
}

/** One stretch of a snippet: matched, or the text between matches. */
export interface SnippetRun {
  /** Where it starts in the snippet: a stable key for the run. */
  start: number
  text: string
  match: boolean
}

/**
 * The snippet cut into runs, the matched ones marked, for a view to draw the
 * matches at full strength. A highlight that overlaps the one before it or
 * runs past the text is skipped, so the runs always join back into `text`.
 */
export function snippetRuns(text: string, highlights: readonly SearchHighlight[]): SnippetRun[] {
  const runs: SnippetRun[] = []
  let at = 0
  for (const [start, end] of highlights) {
    if (start < at || end > text.length) continue
    if (start > at) runs.push({ start: at, text: text.slice(at, start), match: false })
    runs.push({ start, text: text.slice(start, end), match: true })
    at = end
  }
  if (at < text.length) runs.push({ start: at, text: text.slice(at), match: false })
  return runs
}

/**
 * What is still coming, or could not come, under the results: null while
 * there is nothing to say. `environmentName` names a failed environment.
 */
export function chatSearchStatus(
  query: string,
  search: Pick<ChatSearchState, 'failed'>,
  sourceCount: number,
  environmentName?: (environmentId: string) => string | undefined,
): string | null {
  if (query.trim() === '') return null
  if (sourceCount === 0) return 'Message search needs a connected environment on a newer server.'
  if (search.failed.length > 0) {
    const names = search.failed.map((id) => environmentName?.(id) ?? 'An environment')
    return `Couldn’t search ${names.join(', ')}.`
  }
  return null
}

export interface ChatSearchState {
  /** The query `hits` answer, trimmed; empty when there is none. */
  query: string
  hits: PlacedSearchHit[]
  /** Some environment has not answered the latest query yet. */
  pending: boolean
  /** Environments that failed or timed out on the latest query. */
  failed: string[]
}

const IDLE: ChatSearchState = { query: '', hits: [], pending: false, failed: [] }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('search timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Searches every source for `query` once typing settles. Answers land as each
 * environment gives them, merged by position (`mergeSearchHits`); what the
 * last query found stays on screen until the new one's first answer, so the
 * list does not blank between keystrokes. An answer to an older query is
 * dropped. Nothing is asked for an empty query.
 */
export function useChatSearch(
  query: string,
  sources: readonly ChatSearchSource[],
  {
    debounceMs = CHAT_SEARCH_DEBOUNCE_MS,
    timeoutMs = CHAT_SEARCH_TIMEOUT_MS,
    limit = CHAT_SEARCH_LIMIT,
  } = {},
): ChatSearchState {
  const [state, setState] = useState<ChatSearchState>(IDLE)
  const generation = useRef(0)
  const trimmed = query.trim()

  useEffect(() => {
    const current = ++generation.current
    if (trimmed === '' || sources.length === 0) {
      setState(IDLE)
      return
    }
    setState((previous) => ({ ...previous, pending: true, failed: [] }))
    const timer = setTimeout(() => {
      const answers = new Map<string, readonly MessageSearchHit[]>()
      const failed: string[] = []
      let outstanding = sources.length
      const settle = () => {
        if (generation.current !== current) return
        outstanding -= 1
        // Keep the environments' saved order, so equal places merge the same way each time.
        const ordered = sources.flatMap((source) => {
          const hits = answers.get(source.environmentId)
          return hits ? [{ environmentId: source.environmentId, hits }] : []
        })
        setState({
          query: trimmed,
          hits: mergeSearchHits(ordered),
          pending: outstanding > 0,
          failed: [...failed],
        })
      }
      for (const source of sources) {
        withTimeout(source.search(trimmed, limit), timeoutMs).then(
          (hits) => {
            answers.set(source.environmentId, hits)
            settle()
          },
          () => {
            failed.push(source.environmentId)
            settle()
          },
        )
      }
    }, debounceMs)
    return () => clearTimeout(timer)
  }, [trimmed, sources, debounceMs, timeoutMs, limit])

  return state
}
