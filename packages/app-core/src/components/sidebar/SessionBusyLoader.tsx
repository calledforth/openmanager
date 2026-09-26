import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'

/** The 2×2 dot glyph that shows a session's state in the sidebar. Each state
 * moves in its own way, and the motion matches how urgent it is:
 *
 * - `working`: light runs clockwise around the dots (iris).
 * - `needs`: the dots knock twice, rest, and knock again (amber).
 * - `done`: the dots draw together into one dot that pings, until the user
 *   opens the session (mint).
 * - `error`: the dots jolt apart once and then hold still (coral).
 *
 * The motion is pure CSS (globals.css, `.session-busy-*`) and stops under
 * `prefers-reduced-motion`. Colour and shape still carry the state.
 */
export type SessionBusyTone = 'working' | 'needs' | 'done' | 'error'

const DOTS = [0, 1, 2, 3] as const
const SPARKS = [0, 1, 2, 3, 4, 5, 6, 7] as const

const LABEL: Record<SessionBusyTone, string> = {
  working: 'Session in progress',
  needs: 'Session needs your attention',
  done: 'Session finished',
  error: 'Session failed',
}

export function SessionBusyLoader({
  className,
  style,
  tone = 'working',
  burst,
}: {
  className?: string
  style?: CSSProperties
  tone?: SessionBusyTone
  /** Change this to throw one spray of sparks, used when a session finishes. */
  burst?: number
}) {
  return (
    <div
      role="img"
      aria-label={LABEL[tone]}
      className={cn('session-busy-ring', `session-busy-ring--${tone}`, className)}
      style={style}
    >
      {DOTS.map((index) => (
        <i key={index} className="session-busy-dot" aria-hidden="true" />
      ))}
      {burst ? (
        // Keyed so every new burst remounts and plays from the start.
        <span key={burst} className="session-busy-sparks" aria-hidden="true">
          {SPARKS.map((index) => (
            <i
              key={index}
              style={{ '--spark-turn': `${index / SPARKS.length}turn` } as CSSProperties}
            />
          ))}
        </span>
      ) : null}
    </div>
  )
}

/** The glyph a session status earns, or null when it is at rest and shows its age. */
export function sessionBusyTone(status: string): SessionBusyTone | null {
  if (status === 'waiting') return 'needs'
  if (status === 'done') return 'done'
  if (status === 'error') return 'error'
  if (status === 'running' || status === 'busy') return 'working'
  // `ready` / `idle`: nothing is happening and nothing is unseen.
  return null
}
