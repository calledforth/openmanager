import type { ReactNode } from 'react'

import { useRetryCountdown } from './useRetryCountdown'

/**
 * The retry countdown, ticking on its own: once a second only this renders
 * again (its `children` with the new words), never the panel around it.
 * `null` words when nothing is scheduled. Kept free of React Native so it can
 * be mounted in the tests.
 */
export function RetryCountdown({
  retryAt,
  children,
}: {
  retryAt: number | null
  children: (words: string | null) => ReactNode
}) {
  return children(useRetryCountdown(retryAt))
}
