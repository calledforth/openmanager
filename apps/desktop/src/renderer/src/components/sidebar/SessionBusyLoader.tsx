import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'

/** Pac-Man holding station while pellets flow into his mouth, one per chomp.
 *
 * He never moves, so there is no implied finish line and the loop is seamless —
 * the honest shape for an indeterminate "still working" indicator.
 *
 * The chomp animates the path's `d` rather than rotating two half-discs. Both
 * render the same, but `d` is independent of `transform-origin`, which keeps
 * the wedge correct no matter how the SVG is positioned or scaled.
 */
const RADIUS = 8
const CENTER_Y = 12
const PAC_X = 14
/** Where a pellet is swallowed — inside the wedge, not at Pac-Man's outer edge. */
const MOUTH_X = 18
/** Just past the right edge of the viewBox, so pellets fly in from off-canvas. */
const SPAWN_X = 80
const PELLET_COUNT = 4
const TRAVEL = SPAWN_X - MOUTH_X

const VIEW_W = 72
const VIEW_H = 24

/** One open-and-shut cycle. Every pellet arrives on an open mouth. */
export const SESSION_BUSY_CHOMP_MS = 480
const FEED_MS = SESSION_BUSY_CHOMP_MS * PELLET_COUNT

/** Pac-Man's wedge, mouth facing right; `half` is the half-mouth angle. */
function pacPath(half: number) {
  const radians = (half * Math.PI) / 180
  const x = (RADIUS * Math.cos(radians)).toFixed(3)
  const y = (RADIUS * Math.sin(radians)).toFixed(3)
  return `M 0 0 L ${x} ${-y} A ${RADIUS} ${RADIUS} 0 1 0 ${x} ${y} Z`
}

/** Evenly spaced along the run, one swallowed per chomp. The inline transform
 * is what the animation overrides while running, and what spreads the pellets
 * out sensibly when reduced-motion turns the animation off. */
const pellets = Array.from({ length: PELLET_COUNT }, (_, index) => ({
  delay: -index * SESSION_BUSY_CHOMP_MS,
  rest: -index * (TRAVEL / PELLET_COUNT),
}))

export function SessionBusyLoader({
  className,
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="Session in progress"
      className={cn(className)}
      style={style}
    >
      <g aria-hidden="true">
        {pellets.map((pellet) => (
          <circle
            key={pellet.delay}
            className="session-busy-pellet"
            cx={SPAWN_X}
            cy={CENTER_Y}
            r={1.7}
            style={{
              animationDelay: `${pellet.delay}ms`,
              transform: `translateX(${pellet.rest}px)`,
            }}
          />
        ))}
        <path
          className="session-busy-pac"
          transform={`translate(${PAC_X} ${CENTER_Y})`}
          d={pacPath(38)}
        />
      </g>
    </svg>
  )
}

export const SESSION_BUSY_FEED_MS = FEED_MS
export const SESSION_BUSY_TRAVEL = TRAVEL
