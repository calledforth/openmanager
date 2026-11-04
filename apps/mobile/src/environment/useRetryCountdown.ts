import { useEffect, useState } from 'react'

import { retryCountdownWords } from './connection-ui'

/**
 * "Trying again in 8 s" while the controller waits to search again, ticking
 * once a second; `null` otherwise. The tick runs only while there is a
 * countdown and the component is mounted, and stops with either.
 */
export function useRetryCountdown(retryAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (retryAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAt])
  return retryCountdownWords(retryAt, now)
}
