import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useSessionState } from '../../providers/session-provider'

/**
 * Shortest time the pill stays up. Creating a session is often quicker than a
 * glance, and a pill that blinks in and out reads as a glitch, not a status.
 */
export const LAUNCH_PILL_MIN_VISIBLE_MS = 600

/**
 * "Creating session…" just above the composer while a draft's first message
 * becomes a session. The message itself is already in the transcript; this
 * is the only place the launch shows, so nothing else on screen changes state.
 */
export function SessionLaunchPillView({ visible }: { visible: boolean }) {
  const reduceMotion = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="launch"
          role="status"
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 4 }}
          transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
          className="mb-1.5 flex"
        >
          <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-float pl-2.5 pr-3 shadow-float-rest">
            <span
              className="todo-progress-loader shrink-0 text-[var(--basis-text-muted)]"
              aria-hidden="true"
            />
            <span className="truncate text-11-regular leading-none text-[var(--basis-text)]">
              Creating session…
            </span>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/** The pill bound to session state. */
export function SessionLaunchPill() {
  const { pendingDraftSessionStart } = useSessionState()
  return <SessionLaunchPillView visible={useHeldVisible(pendingDraftSessionStart)} />
}

/** `active`, held true for at least the minimum once it turns true. */
function useHeldVisible(active: boolean) {
  const [held, setHeld] = useState(false)
  const shownAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (active) {
      shownAtRef.current ??= Date.now()
      setHeld(true)
      return
    }
    if (shownAtRef.current === null) return
    const remaining = shownAtRef.current + LAUNCH_PILL_MIN_VISIBLE_MS - Date.now()
    const hide = () => {
      shownAtRef.current = null
      setHeld(false)
    }
    if (remaining <= 0) {
      hide()
      return
    }
    const timer = setTimeout(hide, remaining)
    return () => clearTimeout(timer)
  }, [active])
  return active || held
}
