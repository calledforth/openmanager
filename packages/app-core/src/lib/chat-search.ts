import { useEffect, useRef, useState } from 'react'
import type { MessageSearchHit } from '@openmanager/protocol'

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
