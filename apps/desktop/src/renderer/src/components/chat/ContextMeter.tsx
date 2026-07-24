import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

/** Context-window occupancy as reported by the provider's ACP `usage_update`. */
export type ComposerUsage = {
  used: number
  size: number
  percent: number
  cost?: { amount: number; currency: string }
}

const RING_RADIUS = 9
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

type CardCoords = { left: number; bottom: number }

const CARD_WIDTH = 180

function formatCost(cost: { amount: number; currency: string }) {
  return `${cost.amount.toFixed(cost.amount < 1 ? 4 : 2)} ${cost.currency}`
}

/**
 * Ring showing how full the model's context window is. The number lives in the
 * hover card rather than the toolbar: at a glance the fill is the signal, and the
 * exact figures only matter once you go looking for them.
 */
export function ContextMeter({ usage }: { usage: ComposerUsage }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<CardCoords | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  const percent = Math.min(100, Math.max(0, usage.percent))
  // Never round a non-empty context down to a bare "0%".
  const rounded = percent > 0 && percent < 1 ? 1 : Math.round(percent)
  const tone =
    percent >= 95
      ? 'text-red-400'
      : percent >= 80
        ? 'text-amber-500'
        : 'text-[var(--basis-text-muted)]'

  const updateCoords = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - CARD_WIDTH / 2, window.innerWidth - CARD_WIDTH - 8),
    )
    setCoords({ left, bottom: window.innerHeight - rect.top + 8 })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    updateCoords()
    window.addEventListener('resize', updateCoords)
    window.addEventListener('scroll', updateCoords, true)
    return () => {
      window.removeEventListener('resize', updateCoords)
      window.removeEventListener('scroll', updateCoords, true)
    }
  }, [open, updateCoords])

  return (
    <div
      ref={anchorRef}
      className="flex shrink-0 items-center"
      tabIndex={0}
      role="img"
      aria-label={`Context window ${rounded}% full`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <svg viewBox="0 0 24 24" className={cn('h-3.5 w-3.5 -rotate-90', tone)} aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="5"
          className="stroke-[var(--basis-surface-hover)]"
        />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
        />
      </svg>

      {open &&
        coords &&
        createPortal(
          <div
            role="tooltip"
            className={cn(
              'pointer-events-none fixed z-[200] flex flex-col gap-1 px-2.5 py-2',
              'border border-[var(--basis-border)] bg-[var(--basis-canvas-bg)] shadow-xl',
              'rounded-[var(--basis-chat-shell-radius)]',
            )}
            style={{ left: coords.left, bottom: coords.bottom, width: CARD_WIDTH }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-11-medium text-[var(--basis-text-strong)]">Context window</span>
              <span className={cn('tabular-nums text-11-medium leading-none', tone)}>
                {rounded}%
              </span>
            </div>
            <div className="tabular-nums text-[10px] leading-4 text-[var(--basis-text-muted)]">
              {usage.used.toLocaleString()} / {usage.size.toLocaleString()} tokens
            </div>
            {usage.cost && usage.cost.amount > 0 && (
              <div className="flex items-baseline justify-between gap-2 border-t border-[var(--basis-border-muted)] pt-1 text-[10px] leading-4 text-[var(--basis-text-muted)]">
                <span>Session cost</span>
                <span className="tabular-nums">{formatCost(usage.cost)}</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
