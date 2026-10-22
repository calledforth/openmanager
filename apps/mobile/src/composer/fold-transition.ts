import { useEffect, useState } from 'react'

import type { ComposerFold } from './model'

/** Long enough for the fold's 200 ms ease and a frame or two either side. */
export const FOLD_WINDOW_MS = 260

/**
 * Whether the dock's height may animate now: only through a fold (rest,
 * running, prompt) or a new request arriving, for one short window. Text
 * wrapping, an image added, a notice, a question's next slide or a value
 * pushed by the environment change the dock's height too, and land at once.
 */
export function useFoldTransition(fold: ComposerFold, requestId: string | null): boolean {
  const key = `${fold}:${requestId ?? ''}`
  const [seen, setSeen] = useState(key)
  const [armed, setArmed] = useState(false)
  // Armed in the same render the fold changes in, so that commit animates.
  if (seen !== key) {
    setSeen(key)
    setArmed(true)
  }
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), FOLD_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [armed, seen])
  return armed
}
