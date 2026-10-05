import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { spring } from '../fluid/lib/springs'
import { useSidebar } from '../fluid/ui/sidebar'
import { useSidebarDrafts, type PendingDraftDiscard } from '../../providers/sidebar-provider'

/** Marks the composer and what floats above it, for notices to sit clear of. */
export const CHAT_COMPOSER_ATTRIBUTE = 'data-chat-composer'

/** Gap between the notice and the composer below it. */
const ABOVE_COMPOSER = 8

interface ComposerBox {
  left: number
  width: number
  top: number
}

/** Where the floating composer is, while `active`; null when none is on screen. */
function useComposerBox(active: boolean): ComposerBox | null {
  const [box, setBox] = useState<ComposerBox | null>(null)
  useEffect(() => {
    if (!active) return
    const composer = document.querySelector<HTMLElement>(`[${CHAT_COMPOSER_ATTRIBUTE}]`)
    if (!composer) {
      setBox(null)
      return
    }
    const measure = () => {
      const rect = composer.getBoundingClientRect()
      setBox((previous) =>
        previous &&
        previous.left === rect.left &&
        previous.width === rect.width &&
        previous.top === rect.top
          ? previous
          : { left: rect.left, width: rect.width, top: rect.top },
      )
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(composer)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [active])
  return box
}

/**
 * Says a draft was discarded and offers it back. With the sidebar open on a
 * wide screen it rests on the sidebar's foot, where the discard was made; on
 * a phone, or with the sidebar folded away, it floats just above the
 * composer, clear of its corners.
 *
 * The live region is always mounted and the notice is swapped inside it, so
 * assistive tech announces each discard. Pointer or focus inside holds the
 * notice open; a discard made from the keyboard puts focus on Undo, and
 * Escape lets the discard go.
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
  const { isMobile, open, width } = useSidebar()
  const docked = !isMobile && open
  const composer = useComposerBox(!docked && pending !== null)
  const undoRef = useRef<HTMLButtonElement>(null)

  // Pointer and focus each hold it; it runs again only once both have left.
  const inside = useRef({ pointer: false, focus: false })
  const key = pending?.key
  useEffect(() => {
    inside.current = { pointer: false, focus: false }
  }, [key])
  const hold = (part: 'pointer' | 'focus', held: boolean) => {
    const was = inside.current.pointer || inside.current.focus
    inside.current = { ...inside.current, [part]: held }
    const now = inside.current.pointer || inside.current.focus
    if (now !== was) onHold(now)
  }

  const fromKeyboard = pending?.fromKeyboard ?? false
  useEffect(() => {
    if (fromKeyboard) undoRef.current?.focus({ preventScroll: true })
  }, [fromKeyboard, key])

  if (typeof document === 'undefined') return null
  const placement: CSSProperties = docked
    ? { left: 0, bottom: 0, width, padding: 12, justifyContent: 'flex-start' }
    : composer
      ? {
          left: composer.left,
          width: composer.width,
          bottom: window.innerHeight - composer.top + ABOVE_COMPOSER,
          paddingInline: 16,
          justifyContent: 'center',
        }
      : { left: 0, right: 0, bottom: 12, paddingInline: 12, justifyContent: 'center' }

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed z-[500] flex"
      style={placement}
    >
      <AnimatePresence>
        {pending ? (
          <motion.div
            // Keyed by the discard, so a second one replaces the first visibly.
            key={pending.key}
            // A modal sheet (the phone's sidebar) sets the page inert to the
            // pointer; the notice must still take a tap.
            className="pointer-events-auto flex max-w-full items-center gap-1 rounded-float bg-float py-1 pl-3 pr-1 text-[13px] text-foreground shadow-float"
            initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring.moderate }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: spring.moderate.exit }}
            onPointerEnter={() => hold('pointer', true)}
            onPointerLeave={() => hold('pointer', false)}
            onFocus={() => hold('focus', true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                hold('focus', false)
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              onDismiss()
            }}
          >
            <span className="truncate pr-2">Draft discarded</span>
            <button
              ref={undoRef}
              type="button"
              onClick={onUndo}
              className="h-7 shrink-0 rounded-md px-2 font-medium outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring"
            >
              Undo
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring"
            >
              <XIcon className="h-3.5 w-3.5" aria-hidden />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

/**
 * The undo for a discarded draft card, on hosts that have draft cards. Mount
 * it at the shell, beside the sidebar rather than in it: on a phone the
 * sidebar is a modal sheet that closes (and would unmount the notice) on the
 * very tap that reaches for Undo. Render inside the Fluid `SidebarProvider`.
 */
export function DraftDiscardNotice() {
  const drafts = useSidebarDrafts()
  if (!drafts) return null
  return (
    <DraftDiscardToast
      pending={drafts.pendingDiscard}
      onUndo={drafts.undoDiscard}
      onDismiss={drafts.confirmDiscard}
      onHold={drafts.holdDiscard}
    />
  )
}
