import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { spring } from '../fluid/lib/springs'
import type { PendingDraftDiscard } from '../../providers/sidebar-provider'

/**
 * Says a draft was discarded and offers it back, floating over the foot of
 * the sidebar, where the discard was made. The host deletes the draft once
 * the notice goes; reading it (pointer on it, or focus in it) holds it open.
 */
export function DraftDiscardToast({
  pending,
  onUndo,
  onDismiss,
  onHold,
}: {
  pending: PendingDraftDiscard | null
  onUndo: () => void
  onDismiss: () => void
  onHold: (held: boolean) => void
}) {
  const reduceMotion = useReducedMotion() ?? false
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {pending ? (
        <motion.div
          // Keyed by the discard, so a second one replaces the first visibly.
          key={pending.key}
          role="status"
          aria-live="polite"
          className="fixed bottom-3 left-3 z-[500] flex max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-float bg-float py-1 pl-3 pr-1 text-[13px] text-foreground shadow-float"
          initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: spring.moderate }}
          exit={{ opacity: 0, y: 4, scale: 0.98, transition: spring.moderate.exit }}
          onPointerEnter={() => onHold(true)}
          onPointerLeave={() => onHold(false)}
          onFocus={() => onHold(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHold(false)
          }}
        >
          <span className="pr-2">Draft discarded</span>
          <button
            type="button"
            onClick={onUndo}
            className="h-7 rounded-md px-2 font-medium outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            Undo
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            <XIcon className="h-3.5 w-3.5" aria-hidden />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
