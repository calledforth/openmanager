/**
 * The session page with no environment behind it: a fixture thread
 * (`fixture-threads.ts`, one starting from a recorded live run), projected
 * and read through the same shared stores a live session uses, so the dev
 * fixture shows the real page. Only for the fixture's rows; nothing here
 * reaches a server.
 *
 * The thread sits in a small store that changes it the way the environment
 * client does (a new object per event, the untouched entries kept), so a
 * render probe can stream tokens into it and count what re-renders
 * (`driver`, wired up only when `EXPO_PUBLIC_RENDER_PROBE=1`).
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import {
  ActiveThreadStoresContext,
  EMPTY_THREAD_PROJECTION,
  projectThread,
  type ActiveThreadStores,
  type ThreadProjection,
  type UIMessage,
} from '@openmanager/app-core/logic'
import type { ThreadState } from '@openmanager/environment-client'

import {
  doneThread,
  failedThread,
  longThread,
  LONG_THREAD_SESSION_ID,
  permissionThread,
  workingThread,
} from './fixture-threads'
import { threadNoticeSource, type TurnNoticeSource } from './turn-notices'

/** The fixture session that opens the recorded thread. */
export const FIXTURE_THREAD_SESSION_ID = 's-tool-payloads'

const FIXTURE_THREADS: Record<string, (now: number) => ThreadState> = {
  [FIXTURE_THREAD_SESSION_ID]: workingThread,
  's-settings-redesign': permissionThread,
  's-pricing': doneThread,
  's-sync-f2': failedThread,
  [LONG_THREAD_SESSION_ID]: (now) => longThread(now),
}

/** Streams a turn into a fixture thread as the environment's events would. */
export interface FixtureDriver {
  /** A prompt starts a new running turn. */
  begin: (prompt: string) => void
  /** A token lands on the running turn's reply. */
  token: (text: string) => void
  /** The running turn completes. */
  settle: () => void
}

export interface FixtureThread {
  stores: ActiveThreadStores
  notices: TurnNoticeSource
  subscribe: (listener: () => void) => () => void
  getThread: () => ThreadState | null
  getMessages: () => UIMessage[]
  driver: FixtureDriver
}

const iso = () => new Date().toISOString()

export function createFixtureThread(initial: ThreadState | null): FixtureThread {
  let thread = initial
  let projection: ThreadProjection = projectThread(thread, EMPTY_THREAD_PROJECTION)
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const commit = (next: ThreadState) => {
    thread = next
    projection = projectThread(next, projection)
    for (const listener of [...listeners]) listener()
  }
  let sequence = 0
  const runningTurn = () => {
    const turns = thread?.turns ?? []
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!
      if (turn.state === 'running' || turn.state === 'waiting') return turn
    }
    return undefined
  }

  const driver: FixtureDriver = {
    begin(prompt) {
      if (!thread) return
      sequence += 1
      const turnId = `probe-turn-${sequence}`
      const messageId = `probe-user-${sequence}`
      commit({
        ...thread,
        turns: [
          ...thread.turns,
          { turnId, threadId: thread.thread.threadId, state: 'running', startedAt: iso() },
        ],
        messages: [
          ...thread.messages,
          {
            messageId,
            threadId: thread.thread.threadId,
            turnId,
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
        order: [...thread.order, { kind: 'message', id: messageId, turnId }],
      })
    },
    token(text) {
      const turn = runningTurn()
      if (!thread || !turn) return
      const replyId = `${turn.turnId}-reply`
      const index = thread.messages.findIndex((message) => message.messageId === replyId)
      if (index === -1) {
        commit({
          ...thread,
          messages: [
            ...thread.messages,
            {
              messageId: replyId,
              threadId: thread.thread.threadId,
              turnId: turn.turnId,
              role: 'assistant',
              content: [{ type: 'text', text }],
            },
          ],
          order: [...thread.order, { kind: 'message', id: replyId, turnId: turn.turnId }],
        })
        return
      }
      const previous = thread.messages[index]!
      const block = previous.content[0]
      const sofar = block && block.type === 'text' ? block.text : ''
      const messages = [...thread.messages]
      messages[index] = { ...previous, content: [{ type: 'text', text: sofar + text }] }
      commit({ ...thread, messages })
    },
    settle() {
      const turn = runningTurn()
      if (!thread || !turn) return
      commit({
        ...thread,
        turns: thread.turns.map((item) =>
          item === turn ? { ...item, state: 'completed', finishedAt: iso() } : item,
        ),
      })
    },
  }

  return {
    subscribe,
    getThread: () => thread,
    getMessages: () => projection.messages,
    notices: threadNoticeSource(subscribe, () => thread),
    stores: {
      streamingStore: {
        subscribe: (_id, listener) => subscribe(listener),
        get: (id) => projection.byId.get(id)?.streaming,
        ensureHydrated: () => undefined,
      },
      messageContentStore: {
        subscribe: (_id, listener) => subscribe(listener),
        get: (id) => projection.byId.get(id)?.content ?? null,
      },
    },
    driver,
  }
}

const probing = process.env.EXPO_PUBLIC_RENDER_PROBE === '1'

/** The fixture thread for a session (empty for a session without one), one per page. */
export function useFixtureThread(sessionId: string): FixtureThread {
  const fixture = useMemo(
    () => createFixtureThread(FIXTURE_THREADS[sessionId]?.(Date.now()) ?? null),
    [sessionId],
  )
  // The render probe drives the page in front; nothing else ever does.
  useEffect(() => {
    if (!probing) return
    const scope = globalThis as { __omFixtureDriver?: FixtureDriver }
    scope.__omFixtureDriver = fixture.driver
    return () => {
      if (scope.__omFixtureDriver === fixture.driver) delete scope.__omFixtureDriver
    }
  }, [fixture])
  return fixture
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
