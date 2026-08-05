import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'

const CELLS = [6, 17, 28, 39, 50]
const COLUMN_STEP_MS = 480
const ROW_SKEW_MS = 48

/** Column drives the left-to-right drift; the row offset skews each column
 * slightly so the lit cells read as a sine wave instead of a solid bar. */
const cells = CELLS.flatMap((y, row) =>
  CELLS.map((x, column) => ({
    x,
    y,
    delay: column * COLUMN_STEP_MS + row * ROW_SKEW_MS,
  })),
)

export function SessionBusyLoader({
  className,
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return (
    <svg
      viewBox="0 0 56 56"
      role="img"
      aria-label="Session in progress"
      className={cn('text-[var(--basis-accent-blue)]', className)}
      style={style}
    >
      <g aria-hidden="true">
        {cells.map((cell) => (
          <circle
            key={`track-${cell.x}-${cell.y}`}
            cx={cell.x}
            cy={cell.y}
            r={2.4}
            fill="currentColor"
            opacity={0.09}
          />
        ))}
        {cells.map((cell) => (
          <circle
            key={`lit-${cell.x}-${cell.y}`}
            className="session-busy-dot"
            cx={cell.x}
            cy={cell.y}
            r={3.1}
            style={{ animationDelay: `${cell.delay}ms` }}
          />
        ))}
      </g>
    </svg>
  )
}
