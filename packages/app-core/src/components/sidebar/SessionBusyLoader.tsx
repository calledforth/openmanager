import type { CSSProperties } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '../../lib/utils'

/** 2×2 outline-dot ring used as the sidebar session status glyph.
 *
 * - `working` — smooth continuous spin while the session runs.
 * - `needs` — static gold outlines (permission / question); row gets a right dither.
 * - `ready` — static green outlines; cleared to idle once the session is opened.
 */
export type SessionBusyTone = 'working' | 'needs' | 'ready'

const DOTS = [0, 1, 2, 3] as const

export function SessionBusyLoader({
  className,
  style,
  tone = 'working',
}: {
  className?: string
  style?: CSSProperties
  tone?: SessionBusyTone
}) {
  const reduceMotion = useReducedMotion()
  const animate = tone === 'working' && !reduceMotion

  const label =
    tone === 'needs'
      ? 'Session needs your attention'
      : tone === 'ready'
        ? 'Session ready to open'
        : 'Session in progress'

  return (
    <motion.div
      role="img"
      aria-label={label}
      className={cn('session-busy-ring', `session-busy-ring--${tone}`, className)}
      style={style}
      animate={animate ? { rotate: 360 } : undefined}
      transition={animate ? { duration: 2.8, repeat: Infinity, ease: 'linear' } : undefined}
    >
      {DOTS.map((index) => (
        <i key={index} className="session-busy-dot" aria-hidden="true" />
      ))}
    </motion.div>
  )
}

export function sessionBusyTone(status: string): SessionBusyTone | null {
  if (status === 'waiting') return 'needs'
  if (status === 'done') return 'ready'
  if (status === 'running' || status === 'busy') return 'working'
  return null
}
