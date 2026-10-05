import { useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { useAnchorBox, useNoticeAnchor } from '../../lib/notice-anchors'
import { spring } from '../fluid/lib/springs'
import { useSidebar } from '../fluid/ui/sidebar'
import { DRAFT_CARD_ATTRIBUTE } from './sidebar-sessions'
import { useSidebarDrafts, type PendingDraftDiscard } from '../../providers/sidebar-provider'

/** Gap between the notice and what it rests on: the composer, or the sidebar's foot. */
const CLEARANCE = 8

function draftCardButton(draftId: string): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>(`[${DRAFT_CARD_ATTRIBUTE}]`)) {
    if (node.getAttribute(DRAFT_CARD_ATTRIBUTE) === draftId) return node
  }
  return null
}

/** Where focus goes once the notice it was on is gone. */
function focusAfter(choice: 'undo' | 'dismiss', pending: PendingDraftDiscard) {
  const target =
    (choice === 'undo' ? draftCardButton(pending.draftId) : null) ??
    (pending.returnFocus?.isConnected ? pending.returnFocus : null) ??
    document.querySelector<HTMLElement>('[data-sidebar="content"] [role="list"]')
  target?.focus({ preventScroll: true })
}

/**
 * Says a draft was discarded and offers it back. With the sidebar open on a
 * wide screen it rests just above the sidebar's foot, where the discard was
 * made; on a phone, or with the sidebar folded away, it floats just above the
 * composer, clear of its corners. Both are found as they register
 * (`noticeAnchorRef`), so one that mounts or moves later moves the notice.
 *
 * The live region is always mounted and the notice is swapped inside it, so
 * assistive tech announces each discard. Pointer or focus inside holds the
 * notice open; a discard made from the keyboard puts focus on Undo, Escape
 * lets the discard go, and focus then returns to the card list.
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
  const showing = pending !== null
  const foot = useAnchorBox(useNoticeAnchor('sidebar-foot'), docked && showing)
  const composer = useAnchorBox(useNoticeAnchor('composer'), !docked && showing)
  const rootRef = useRef<HTMLDivElement>(null)
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

  // Closed from inside, with focus on it: focus goes back to the cards once
  // the notice has gone (and an undone card is back), not to the page body.
  const returning = useRef<{ choice: 'undo' | 'dismiss'; pending: PendingDraftDiscard } | null>(
    null,
  )
  const close = (choice: 'undo' | 'dismiss') => {
    const had = pending && rootRef.current?.contains(document.activeElement)
    returning.current = had ? { choice, pending } : null
    if (choice === 'undo') onUndo()
    else onDismiss()
  }
  useEffect(() => {
    const request = returning.current
    if (!request || pending?.key === request.pending.key) return
    returning.current = null
    // Only if nothing else has taken focus meanwhile.
    const active = document.activeElement
    if (active && active !== document.body && !rootRef.current?.contains(active)) return
    focusAfter(request.choice, request.pending)
  }, [pending])

  if (typeof document === 'undefined') return null
  const placement: CSSProperties = docked
    ? {
        left: 0,
        width,
        bottom: foot ? window.innerHeight - foot.top + CLEARANCE / 2 : 12,
        paddingInline: 12,
        justifyContent: 'flex-start',
      }
    : composer
      ? {
          left: composer.left,
          width: composer.width,
          bottom: window.innerHeight - composer.top + CLEARANCE,
          paddingInline: 16,
          justifyContent: 'center',
        }
      : { left: 0, right: 0, bottom: 12, paddingInline: 12, justifyContent: 'center' }

  return createPortal(
    <div
      ref={rootRef}
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
              close('dismiss')
            }}
          >
            <span className="truncate pr-2">Draft discarded</span>
            <button
              ref={undoRef}
              type="button"
              onClick={() => close('undo')}
              className="h-7 shrink-0 rounded-md px-2 font-medium outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring"
            >
              Undo
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => close('dismiss')}
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
