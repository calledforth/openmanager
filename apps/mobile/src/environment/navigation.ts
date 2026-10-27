import { BLANK_DRAFT, draftHref, landingOf, sessionHref } from './landing-route'

/** The part of expo-router's imperative router the shared navigation needs. */
export interface PhoneRouter {
  push(href: string): void
  replace(href: string): void
  setParams(params: Record<string, string>): void
}

/** How long a navigation may take to show in the address before it counts as settled. */
export const ARRIVAL_TIMEOUT_MS = 1500

const decoded = (path: string) => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * The shared session state's navigation (`navigateSession`, `navigateDraft`)
 * over the phone's routes. Each answers once the address in front reads its
 * destination, as web's router answers once it has moved: the shared state
 * holds the page it opened until then, and an address that has not caught up
 * yet must not read as the user's own move.
 *
 * A blank page that gets its first text becomes its draft's page in place
 * (the route's params change, the screen stays), so the field being typed
 * in keeps its focus and the keyboard stays up, as on web, where the page is
 * the same component at either address.
 *
 * A session that takes a new-session page's place (`replace`) does so only
 * while such a page is in front. One whose launch finishes after the reader
 * went back (to the home, say) leaves them where they are: the phone's stack
 * has no blank page under the home to stand in for, and replacing the home
 * would lose it. `stayed` hears of it, so the session the launch selected is
 * not left held by a page that never came; its row shows it running.
 */
export function createPhoneNavigation(
  router: PhoneRouter,
  {
    timers = {
      setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    stayed,
  }: {
    timers?: {
      setTimeout: (run: () => void, ms: number) => unknown
      clearTimeout: (handle: unknown) => void
    }
    /** A session's page was not opened in a new-session page's place: the reader left it. */
    stayed?: (sessionId: string) => void
  } = {},
) {
  let path = ''
  const waiters = new Set<{ to: string; done: () => void }>()

  const go = (to: string, move: () => void): Promise<void> => {
    if (decoded(path) === decoded(to)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiter = {
        to,
        done: () => {
          if (!waiters.delete(waiter)) return
          timers.clearTimeout(handle)
          resolve()
        },
      }
      // Never held for good: a navigation the user overtook settles anyway.
      const handle = timers.setTimeout(waiter.done, ARRIVAL_TIMEOUT_MS)
      waiters.add(waiter)
      try {
        move()
      } catch {
        waiter.done()
      }
    })
  }

  /** A new-session page is in front. */
  const onLanding = () => landingOf(path).onLanding

  return {
    /** The address in front changed: navigations that reached it are settled. */
    arrived(pathname: string) {
      path = pathname
      for (const waiter of [...waiters]) {
        if (decoded(waiter.to) === decoded(pathname)) waiter.done()
      }
    },

    navigateDraft(draftId: string, options?: { replace?: boolean }): Promise<void> {
      const to = draftHref(draftId)
      return go(to, () => {
        // In place: the blank page becoming its draft's own, or one draft
        // page taking another's address.
        if (options?.replace && onLanding()) router.setParams({ draftId })
        else if (options?.replace) router.replace(to)
        else router.push(to)
      })
    },

    navigateSession(sessionId: string | null, options?: { replace?: boolean }): Promise<void> {
      if (sessionId !== null) {
        const to = sessionHref(sessionId)
        if (options?.replace && !onLanding() && decoded(path) !== decoded(to)) {
          stayed?.(sessionId)
          return Promise.resolve()
        }
        return go(to, () => (options?.replace ? router.replace(to) : router.push(to)))
      }
      // The blank page: on a new-session page, that page becomes it.
      const to = draftHref(null)
      return go(to, () => {
        if (onLanding()) router.setParams({ draftId: BLANK_DRAFT })
        else if (options?.replace) router.replace(to)
        else router.push(to)
      })
    },
  }
}

export type PhoneNavigation = ReturnType<typeof createPhoneNavigation>
