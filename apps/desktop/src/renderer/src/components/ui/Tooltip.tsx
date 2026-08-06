import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

type TooltipCoords = { left: number; top: number }

/** Gap between the trigger edge and the tooltip. */
const GAP = 6
/** Keep the bubble this far from the viewport edges. */
const EDGE = 8
/** Pointer dwell before the tooltip appears. Keyboard focus shows instantly. */
const OPEN_DELAY = 350
const CLOSE_DELAY = 60

type TriggerProps = {
  ref?: Ref<HTMLElement>
  onPointerEnter?: (event: React.PointerEvent) => void
  onPointerLeave?: (event: React.PointerEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onPointerDown?: (event: React.PointerEvent) => void
  'aria-describedby'?: string
}

let tooltipIdCounter = 0

/**
 * The one hover-tip in the app. Wraps a single element child, portals a bubble
 * next to it, and stays out of layout so it can sit inside any flex row.
 *
 * Prefer this over the native `title` attribute everywhere: `title` has a ~1s
 * delay we can't control, ignores the theme, and never shows on keyboard focus.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  align = 'center',
  disabled,
  wrapperClassName,
  children,
}: {
  /** Tip body. Falsy content renders the child untouched. */
  content?: ReactNode
  /** Optional key hint rendered as a dim suffix, e.g. `⌘K`. */
  shortcut?: string
  side?: TooltipSide
  align?: 'start' | 'center' | 'end'
  /** Suppress the tip entirely (renders the child untouched). */
  disabled?: boolean
  /** Extra classes for the wrapper used when the child is a disabled control. */
  wrapperClassName?: string
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<TooltipCoords | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = useRef<string | null>(null)
  if (idRef.current === null) idRef.current = `tooltip-${++tooltipIdCounter}`
  const tooltipId = idRef.current

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const show = useCallback(
    (delay: number) => {
      clearTimers()
      if (delay <= 0) {
        setOpen(true)
        return
      }
      openTimer.current = setTimeout(() => setOpen(true), delay)
    },
    [clearTimers],
  )

  const hide = useCallback(
    (delay: number) => {
      clearTimers()
      if (delay <= 0) {
        setOpen(false)
        return
      }
      closeTimer.current = setTimeout(() => setOpen(false), delay)
    },
    [clearTimers],
  )

  const position = useCallback(() => {
    const trigger = triggerRef.current
    const bubble = bubbleRef.current
    if (!trigger || !bubble) return
    const t = trigger.getBoundingClientRect()
    const b = bubble.getBoundingClientRect()

    let left: number
    let top: number

    if (side === 'top' || side === 'bottom') {
      top = side === 'top' ? t.top - b.height - GAP : t.bottom + GAP
      left =
        align === 'start'
          ? t.left
          : align === 'end'
            ? t.right - b.width
            : t.left + t.width / 2 - b.width / 2
      // Flip when the preferred side has no room.
      if (side === 'top' && top < EDGE) top = t.bottom + GAP
      if (side === 'bottom' && top + b.height > window.innerHeight - EDGE) {
        top = t.top - b.height - GAP
      }
    } else {
      left = side === 'left' ? t.left - b.width - GAP : t.right + GAP
      top =
        align === 'start'
          ? t.top
          : align === 'end'
            ? t.bottom - b.height
            : t.top + t.height / 2 - b.height / 2
      if (side === 'left' && left < EDGE) left = t.right + GAP
      if (side === 'right' && left + b.width > window.innerWidth - EDGE) {
        left = t.left - b.width - GAP
      }
    }

    left = Math.max(EDGE, Math.min(left, window.innerWidth - b.width - EDGE))
    top = Math.max(EDGE, Math.min(top, window.innerHeight - b.height - EDGE))
    setCoords({ left, top })
  }, [align, side])

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    position()
  }, [open, position, content, shortcut])

  useEffect(() => {
    if (!open) return
    const onMove = () => hide(0)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, hide])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide(0)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, hide])

  if (!isValidElement(children)) return children ?? null
  if (!content || disabled) return children

  const childProps = children.props as TriggerProps & { disabled?: boolean }
  const setRef = (node: HTMLElement | null) => {
    triggerRef.current = node
    const ref = childProps.ref
    if (typeof ref === 'function') ref(node)
    else if (ref && typeof ref === 'object') {
      ;(ref as { current: HTMLElement | null }).current = node
    }
  }

  const handlers = {
    onPointerEnter: (event: React.PointerEvent) => {
      // Touch/pen taps shouldn't strand a tip on screen.
      if (event.pointerType === 'mouse') show(OPEN_DELAY)
    },
    onPointerLeave: () => hide(CLOSE_DELAY),
    onPointerDown: () => hide(0),
  }

  // Disabled form controls swallow pointer events, so the tip that explains
  // *why* they're disabled would never fire. Listen on a wrapper instead.
  const trigger = childProps.disabled ? (
    <span ref={setRef} className={cn('inline-flex shrink-0', wrapperClassName)} {...handlers}>
      {children}
    </span>
  ) : (
    cloneElement(children as ReactElement<TriggerProps>, {
      ref: setRef,
      'aria-describedby': open ? tooltipId : childProps['aria-describedby'],
      onPointerEnter: (event: React.PointerEvent) => {
        childProps.onPointerEnter?.(event)
        handlers.onPointerEnter(event)
      },
      onPointerLeave: (event: React.PointerEvent) => {
        childProps.onPointerLeave?.(event)
        hide(CLOSE_DELAY)
      },
      onPointerDown: (event: React.PointerEvent) => {
        childProps.onPointerDown?.(event)
        hide(0)
      },
      onFocus: (event: React.FocusEvent) => {
        childProps.onFocus?.(event)
        // Only keyboard focus — a click already dismissed it above.
        if (event.target.matches?.(':focus-visible')) show(0)
      },
      onBlur: (event: React.FocusEvent) => {
        childProps.onBlur?.(event)
        hide(0)
      },
    })
  )

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={tooltipId}
            role="tooltip"
            className={cn(
              'pointer-events-none fixed z-[400] flex max-w-[260px] items-center gap-1.5',
              'rounded-[6px] border border-[var(--basis-border)] bg-[var(--basis-surface-elevated)]',
              'px-2 py-1 text-[11px] leading-4 text-[var(--basis-text)] shadow-lg',
              coords ? 'basis-tooltip-in opacity-100' : 'opacity-0',
            )}
            style={{ left: coords?.left ?? 0, top: coords?.top ?? 0 }}
          >
            <span className="min-w-0">{content}</span>
            {shortcut && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--basis-text-faint)]">
                {shortcut}
              </span>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
