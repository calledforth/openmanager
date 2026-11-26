import { useEffect, useRef } from 'react'

/**
 * Asks whoever shows pull requests (web's side panel) to open one. The chat
 * pane's right column lists the session's pull requests but holds no panel
 * of its own, and the panel is not under it in the tree, so the two meet
 * here rather than through context.
 */
type Listener = (key: string) => void

const listeners = new Set<Listener>()

/**
 * Open the pull request with this key (`pullRequestKey`). False when nothing
 * listens, so the caller can fall back (open it on GitHub).
 */
export function requestOpenPullRequest(key: string): boolean {
  if (listeners.size === 0) return false
  for (const listener of listeners) listener(key)
  return true
}

/** Listen for `requestOpenPullRequest` while mounted. */
export function useOpenPullRequestRequests(listener: Listener): void {
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => {
    const forward: Listener = (key) => latest.current(key)
    listeners.add(forward)
    return () => {
      listeners.delete(forward)
    }
  }, [])
}
