import { useEffect, useRef, useState } from 'react'
import { selectOpenChatCatchingUp, type EnvironmentState } from '@openmanager/environment-client'
import {
  useEnvironmentClientOptional,
  useEnvironmentState,
} from '../../providers/environment-client'
import { ComposerStatusPill } from './SessionLaunchPill'

/**
 * How long a catch-up runs before the pill shows. Most answers land sooner,
 * and a chat that was current a moment later needed no status at all.
 */
export const SYNCING_PILL_DELAY_MS = 500

/** Shortest time the pill stays once shown: less reads as a flicker, not a status. */
export const SYNCING_PILL_MIN_VISIBLE_MS = 300

const selectActiveThreadId = (state: EnvironmentState) => state.activeThreadId
const selectConnected = (state: EnvironmentState) => state.connection.phase === 'connected'

/**
 * Whether the pill is up, given whether the open chat is catching up. A
 * different chat starts over, and a connection problem hides it at once: the
 * connection's own status wins, and the two never show together.
 */
export function useSyncingPill(catchingUp: boolean, chatId: string | null, hidden: boolean) {
  const [visible, setVisible] = useState(false)
  const shownAtRef = useRef<number | null>(null)
  const chatRef = useRef(chatId)

  useEffect(() => {
    const hide = () => {
      shownAtRef.current = null
      setVisible(false)
    }
    const moved = chatRef.current !== chatId
    chatRef.current = chatId
    if (hidden || moved) hide()
    if (hidden) return
    if (catchingUp) {
      if (shownAtRef.current !== null) return
      const timer = setTimeout(() => {
        shownAtRef.current = Date.now()
        setVisible(true)
      }, SYNCING_PILL_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (shownAtRef.current === null) return
    const left = shownAtRef.current + SYNCING_PILL_MIN_VISIBLE_MS - Date.now()
    if (left <= 0) {
      hide()
      return
    }
    const timer = setTimeout(hide, left)
    return () => clearTimeout(timer)
  }, [catchingUp, chatId, hidden])

  return visible && !hidden
}

/**
 * "Syncing…" above the composer when the open chat is out of date and catching
 * up is taking a moment. It is about time, not about disconnects: a catch-up
 * that lands quickly shows nothing. Its own component, so that it reads the
 * signal alone and nothing here renders per token.
 */
export function SyncingPill({ connectionProblem = false }: { connectionProblem?: boolean }) {
  const client = useEnvironmentClientOptional()
  return client ? <BoundSyncingPill connectionProblem={connectionProblem} /> : null
}

function BoundSyncingPill({ connectionProblem }: { connectionProblem: boolean }) {
  const catchingUp = useEnvironmentState(selectOpenChatCatchingUp)
  const chatId = useEnvironmentState(selectActiveThreadId)
  const connected = useEnvironmentState(selectConnected)
  const blocked = connectionProblem || !connected
  const visible = useSyncingPill(catchingUp, chatId, blocked)
  // Out of the tree, not faded: the two statuses never show together.
  return blocked ? null : <ComposerStatusPill visible={visible} label="Syncing…" />
}
