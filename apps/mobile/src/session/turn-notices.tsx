/**
 * What the environment noted about a turn (a retry, a rate limit, a
 * provider message), for the placeholder row under it. The thread keeps its
 * notices beside its turns, not inside the rows the timeline lists, so a
 * row reads its turn's notices through this source: one subscription per
 * row, handing out the same array until that turn's notices change, so a
 * streamed token re-renders no row for it. Rich notice rows come later; the
 * placeholder shows the environment's own words.
 */
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ThreadState } from '@openmanager/environment-client'

export interface TurnNoticeSource {
  subscribe: (listener: () => void) => () => void
  get: (turnId: string) => readonly string[]
}

const NONE: readonly string[] = []
const noop = () => undefined
const EMPTY_SOURCE: TurnNoticeSource = { subscribe: () => noop, get: () => NONE }

const byList = new WeakMap<ThreadState['notices'], Map<string, string[]>>()

/** A thread's notices by turn, split once per list the store hands out. */
export function noticesOfTurn(
  notices: ThreadState['notices'] | undefined,
  turnId: string,
): readonly string[] {
  if (!notices || notices.length === 0) return NONE
  let split = byList.get(notices)
  if (!split) {
    split = new Map()
    for (const notice of notices) {
      const list = split.get(notice.turnId)
      if (list) list.push(notice.message)
      else split.set(notice.turnId, [notice.message])
    }
    byList.set(notices, split)
  }
  return split.get(turnId) ?? NONE
}

/** A source over a thread that can change: the live client's active thread. */
export function threadNoticeSource(
  subscribe: (listener: () => void) => () => void,
  thread: () => Pick<ThreadState, 'notices'> | null | undefined,
): TurnNoticeSource {
  return { subscribe, get: (turnId) => noticesOfTurn(thread()?.notices, turnId) }
}

const TurnNoticesContext = createContext<TurnNoticeSource>(EMPTY_SOURCE)

export function TurnNoticesProvider({
  source,
  children,
}: {
  source: TurnNoticeSource
  children: ReactNode
}) {
  return <TurnNoticesContext.Provider value={source}>{children}</TurnNoticesContext.Provider>
}

/** The notices of `turnId`; none for a row that is not a turn's reply. */
export function useTurnNotices(turnId: string | null): readonly string[] {
  const source = useContext(TurnNoticesContext)
  const get = useCallback(() => (turnId ? source.get(turnId) : NONE), [source, turnId])
  return useSyncExternalStore(source.subscribe, get, get)
}
