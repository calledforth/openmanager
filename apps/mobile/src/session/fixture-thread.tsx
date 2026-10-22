/**
 * The session page with no environment behind it: a thread recorded from a
 * live run (`recorded-thread.ts`), projected and read through the same shared
 * stores a live session uses, so the dev fixture shows the real page. Only
 * for the fixture's rows; nothing here reaches a server.
 */
import { useMemo, type ReactNode } from 'react'
import {
  ActiveThreadStoresContext,
  projectThread,
  type ActiveThreadStores,
  type UIMessage,
} from '@openmanager/app-core/logic'
import type { ThreadState } from '@openmanager/environment-client'

import { RECORDED_THREAD } from './recorded-thread'

/** The fixture session that opens the recorded thread. */
export const FIXTURE_THREAD_SESSION_ID = 's-tool-payloads'

const FIXTURE_THREADS: Record<string, ThreadState> = {
  [FIXTURE_THREAD_SESSION_ID]: RECORDED_THREAD,
}

const noop = () => undefined

/** The fixture thread's rows and the stores they read, or nothing for a session without one. */
export function useFixtureThread(sessionId: string): {
  messages: UIMessage[]
  stores: ActiveThreadStores
} {
  return useMemo(() => {
    const projection = projectThread(FIXTURE_THREADS[sessionId] ?? null)
    return {
      messages: projection.messages,
      stores: {
        streamingStore: {
          subscribe: () => noop,
          get: (id) => projection.byId.get(id)?.streaming,
          ensureHydrated: noop,
        },
        messageContentStore: {
          subscribe: () => noop,
          get: (id) => projection.byId.get(id)?.content ?? null,
        },
      },
    }
  }, [sessionId])
}

export function FixtureThreadStores({
  stores,
  children,
}: {
  stores: ActiveThreadStores
  children: ReactNode
}) {
  return (
    <ActiveThreadStoresContext.Provider value={stores}>
      {children}
    </ActiveThreadStoresContext.Provider>
  )
}
