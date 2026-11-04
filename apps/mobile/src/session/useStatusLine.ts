import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ThreadState } from '@openmanager/environment-client'

import { statusMarkOf, type HomeSession } from '../home/rows'
import {
  clockFromKey,
  clockKey,
  failureDetailOf,
  statusClockOf,
  statusLineView,
  type StatusLineView,
} from './status-line'

/**
 * The status line for the session on screen. The state is the listed
 * session's; its thread lends the server's timestamps. Both reads are
 * strings, so a streamed token, which changes the thread but not when the
 * turn started, hands back the same line and nothing re-renders.
 */
export function useStatusLine(
  session: HomeSession | undefined,
  subscribe: (listener: () => void) => () => void,
  getThread: () => ThreadState | null | undefined,
): StatusLineView | null {
  const mark = session ? statusMarkOf(session) : 'idle'
  const clock = useCallback(() => clockKey(statusClockOf(mark, getThread())), [getThread, mark])
  const failure = useCallback(
    () => (mark === 'error' ? (failureDetailOf(getThread()) ?? '') : ''),
    [getThread, mark],
  )
  const key = useSyncExternalStore(subscribe, clock, clock)
  const detail = useSyncExternalStore(subscribe, failure, failure)
  return useMemo(() => {
    const view = statusLineView(session, null)
    return view ? { ...view, clock: clockFromKey(key), detail: detail || null } : null
  }, [detail, key, session])
}
