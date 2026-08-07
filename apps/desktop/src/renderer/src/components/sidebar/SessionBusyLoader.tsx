import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'

/** 3×3 cube face used as the sidebar session status glyph.
 *
 * - `working` — spiral solve: stickers light in a spiral; geometry stays put.
 * - `needs` — cross blink: center holds, plus-shaped edges pulse (permission /
 *   question). Corners stay quiet so it reads as a cross, not a scramble.
 */
export type SessionBusyTone = 'working' | 'needs'

const CELLS = Array.from({ length: 9 }, (_, index) => index)

export function SessionBusyLoader({
  className,
  style,
  tone = 'working',
}: {
  className?: string
  style?: CSSProperties
  tone?: SessionBusyTone
}) {
  return (
    <div
      role="img"
      aria-label={tone === 'needs' ? 'Session needs your attention' : 'Session in progress'}
      className={cn('session-busy-cube', `session-busy-cube--${tone}`, className)}
      style={style}
    >
      {CELLS.map((index) => (
        <i key={index} className="session-busy-cell" aria-hidden="true" />
      ))}
    </div>
  )
}

export function sessionBusyTone(status: string): SessionBusyTone {
  return status === 'waiting' ? 'needs' : 'working'
}
