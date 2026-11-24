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
  type Lineage,
  type LineageSession,
  type ThreadProjection,
  type UIMessage,
} from '@openmanager/app-core/logic'
import type { Subagent } from '@openmanager/protocol'
import type { BackgroundTask, ThreadState } from '@openmanager/environment-client'

import { FIXTURE_WORKSPACES } from '../home/fixture'
import { lineageReader } from './subagent-lineage'
import type { HomeSession } from '../home/rows'
import {
  backgroundThread,
  CODEX_THREAD_SESSION_ID,
  codexThread,
  delegatedThread,
  doneThread,
  FIXTURE_LINEAGE,
  FIXTURE_TASKS,
  failedThread,
  imagesThread,
  longThread,
  LONG_THREAD_SESSION_ID,
  permissionThread,
  workingThread,
} from './fixture-threads'

/** The fixture session that opens the recorded thread. */
export const FIXTURE_THREAD_SESSION_ID = 's-tool-payloads'

const FIXTURE_THREADS: Record<string, (now: number) => ThreadState> = {
  [FIXTURE_THREAD_SESSION_ID]: workingThread,
  's-settings-redesign': permissionThread,
  's-pricing': doneThread,
  's-sync-f2': failedThread,
  's-mcp-server': backgroundThread,
  's-soul-id': imagesThread,
  [LONG_THREAD_SESSION_ID]: (now) => longThread(now),
  [CODEX_THREAD_SESSION_ID]: codexThread,
  's-tool-payloads-tests': delegatedThread,
}

/**
 * The listing of a fixture session the sample home has no row for: the Codex
 * session, opened by its address (`/session/s-codex-settings`).
 */
export function fixtureSessionSummary(sessionId: string): HomeSession | undefined {
  if (sessionId !== CODEX_THREAD_SESSION_ID) return undefined
  return {
    externalId: sessionId,
    title: 'Settings cards flash on load',
    status: 'running',
    providerId: 'codex' as HomeSession['providerId'],
    isDriven: false,
    workspacePath: FIXTURE_WORKSPACES[0]!.path,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * The fixture's follow-ups, done to its thread as the environment would do
 * them: a queued message waits, a steered one waits on the command running,
 * and Send now stops that turn and runs the message as the next one.
 */
export interface FixtureFollowUps {
  queue: (text: string) => void
  steer: (text: string) => void
  remove: (queueItemId: string) => Promise<void>
  resume: () => Promise<void>
  sendNow: (queueItemId: string) => Promise<void>
  /** A subagent's Stop: it reads as stopped a beat later, as the environment would say. */
  stopSubagent: (subagent: Subagent) => Promise<void>
  /** The background work's Stop: the tasks named, or all of them, leave the list. */
  stopTasks: (taskIds?: string[]) => Promise<void>
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
  subscribe: (listener: () => void) => () => void
  getThread: () => ThreadState | null
  getMessages: () => UIMessage[]
  /** The work the session left running, as the environment lists it. */
  getTasks: () => readonly BackgroundTask[]
  /** Its subagents, at any depth, as the environment's sessions would list them. */
  getLineage: () => Lineage
  driver: FixtureDriver
  followUps: FixtureFollowUps
}

const iso = () => new Date().toISOString()

const NO_TASKS: readonly BackgroundTask[] = []

export function createFixtureThread(
  initial: ThreadState | null,
  initialTasks: readonly BackgroundTask[] = NO_TASKS,
  /** The child sessions under it, as summaries name them (its own is added). */
  lineageSessions: readonly LineageSession[] = [],
): FixtureThread {
  let thread = initial
  let tasks = initialTasks
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

  let added = 0
  const enqueue = (text: string, delivery: 'queued' | 'steering') => {
    if (!thread) return
    added += 1
    const queueItemId = `fixture-${delivery}-${added}`
    commit({
      ...thread,
      queue: {
        ...thread.queue,
        items: [
          ...thread.queue.items,
          { queueItemId, text, settings: {}, delivery, createdAt: iso() },
        ],
      },
      ...(delivery === 'steering'
        ? { steeredQueueIds: [...(thread.steeredQueueIds ?? []), queueItemId] }
        : {}),
    })
  }
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  const followUps: FixtureFollowUps = {
    stopSubagent: async (subagent) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      if (!thread?.subagents) return
      const at = iso()
      commit({
        ...thread,
        subagents: thread.subagents.map((entry) =>
          entry.subagentId === subagent.subagentId
            ? { ...entry, status: 'cancelled' as const, finishedAt: at, updatedAt: at }
            : entry,
        ),
      })
    },
    stopTasks: async (taskIds) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      tasks = taskIds ? tasks.filter((task) => !taskIds.includes(task.taskId)) : NO_TASKS
      notify()
    },
    queue: (text) => enqueue(text, 'queued'),
    steer: (text) => enqueue(text, 'steering'),
    remove: async (queueItemId) => {
      if (!thread) return
      commit({
        ...thread,
        queue: {
          ...thread.queue,
          items: thread.queue.items.filter((item) => item.queueItemId !== queueItemId),
        },
      })
    },
    resume: async () => {
      if (thread) commit({ ...thread, queue: { ...thread.queue, pausedBy: null } })
    },
    sendNow: async (queueItemId) => {
      const item = thread?.queue.items.find((entry) => entry.queueItemId === queueItemId)
      if (!thread || !item) return
      // Given back first, then first in line, as the environment does.
      commit({
        ...thread,
        queue: {
          ...thread.queue,
          items: [
            { ...item, delivery: 'queued' },
            ...thread.queue.items.filter((entry) => entry !== item),
          ],
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (!thread) return
      const current = thread
      const turnId = `fixture-turn-${queueItemId}`
      const messageId = `fixture-message-${queueItemId}`
      const at = iso()
      commit({
        ...current,
        turns: [
          ...current.turns.map((turn) =>
            turn.state === 'running' || turn.state === 'waiting'
              ? { ...turn, state: 'interrupted' as const, finishedAt: at }
              : turn,
          ),
          {
            turnId,
            threadId: current.thread.threadId,
            state: 'running',
            startedAt: at,
            commandId: queueItemId,
          },
        ],
        messages: [
          ...current.messages,
          {
            messageId,
            threadId: current.thread.threadId,
            turnId,
            role: 'user',
            content: [{ type: 'text', text: item.text }],
          },
        ],
        order: [...current.order, { kind: 'message', id: messageId, turnId }],
        // The prompt keeps the row the steered message had.
        confirmedEchoes: { ...current.confirmedEchoes, [messageId]: queueItemId },
      })
      if (!thread) return
      commit({
        ...thread,
        queue: {
          ...thread.queue,
          items: thread.queue.items.filter((entry) => entry.queueItemId !== queueItemId),
        },
        steeredQueueIds: (thread.steeredQueueIds ?? []).filter((id) => id !== queueItemId),
      })
    },
  }

  // The page's own session, holding the thread, then the children it lists.
  const root = initial?.thread.sessionId
  const sessions: Record<string, LineageSession> = {}
  if (initial && root) {
    sessions[root] = {
      sessionId: root,
      title: '',
      status: 'running',
      providerId: 'claude',
      threadIds: [initial.thread.threadId],
    }
    for (const child of lineageSessions) sessions[child.sessionId] = child
  }
  const getLineage = lineageReader(
    () => ({ sessions, threads: thread ? { [thread.thread.threadId]: thread } : {} }),
    root ?? '',
  )

  return {
    followUps,
    subscribe,
    getThread: () => thread,
    getMessages: () => projection.messages,
    getTasks: () => tasks,
    getLineage,
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
    () =>
      createFixtureThread(
        FIXTURE_THREADS[sessionId]?.(Date.now()) ?? null,
        FIXTURE_TASKS[sessionId] ?? NO_TASKS,
        FIXTURE_LINEAGE[sessionId],
      ),
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
