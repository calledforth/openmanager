/**
 * A session on screen, read-only: opened with `session.open` as web's
 * session route opens it, its transcript from the snapshot and the live
 * events through the shared active-thread provider, and released when the
 * page goes (`setActiveSession(null)` unsubscribes its scopes). Older pages
 * of the transcript (`session.history`) are never asked for here: the phone
 * shows what the snapshot and the events bring. An environment that cannot
 * replay a session's events (`subscription.replay`) is not opened at all,
 * since the shared client would fill the transcript from `session.history`
 * there instead.
 *
 * The page owns the client's one active session while it is the page in
 * front: it opens it on focus when another page took it, and releases it
 * only if it is still its own, so a page left under another (a search, a
 * second session) neither leaks it nor takes it from the one in front.
 *
 * Nothing is decided on the phone: the status is the listed session's, and
 * "done" is cleared by asking the environment (`acknowledgeSessionDone`)
 * once the session is on screen, never locally.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  SidebarDataContext,
  useActiveThreadState,
  useEnvironmentClient,
  useEnvironmentState,
  type UIMessage,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'
import { isEnvironmentClientError, type EnvironmentState } from '@openmanager/environment-client'

import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import type { HomeSession } from '../home/rows'
import { useHomeSource } from '../home/source'

/**
 * - `opening`: asked for, the snapshot is on its way (or the socket is).
 * - `ready`: the snapshot is in; live events follow.
 * - `failed`: the environment could not open it; `retry` asks again.
 * - `gone`: the environment has no such session (deleted, here or elsewhere).
 * - `unsupported`: the environment cannot replay events, so the phone does
 *   not open its sessions.
 */
export type ReadOnlySessionPhase = 'opening' | 'ready' | 'failed' | 'gone' | 'unsupported'

/** What the phone needs to open a session without asking for its history. */
export const REPLAY_CAPABILITY = 'subscription.replay'

export interface ReadOnlySession {
  /** The listed session: title, status, project. Absent until the list has it. */
  session: HomeSession | undefined
  workspace: WorkspaceEntry | undefined
  /** The thread's own title, for a session the list has not reached. */
  title: string | undefined
  messages: UIMessage[]
  phase: ReadOnlySessionPhase
  /** Why it failed, in the environment's words. */
  failure: string | null
  retry: () => void
}

const selectConnected = (state: EnvironmentState) => state.connection.phase === 'connected'
const selectReplays = (state: EnvironmentState) =>
  state.connection.capabilities.includes(REPLAY_CAPABILITY)
const NO_MESSAGES: UIMessage[] = []
const noop = () => undefined

/**
 * `focused`: this page is the one in front (the router's `useIsFocused`).
 */
export function useReadOnlySession(
  sessionId: string,
  { focused = true }: { focused?: boolean } = {},
): ReadOnlySession {
  const client = useEnvironmentClient()
  const thread = useActiveThreadState()
  const sidebar = useContext(SidebarDataContext)
  const { sessions, workspaces } = useHomeSource()
  const { activity } = usePhoneConnection()
  const connected = useEnvironmentState(selectConnected)
  const replays = useEnvironmentState(selectReplays)
  const known = useEnvironmentState(
    useCallback((state: EnvironmentState) => state.sessions[sessionId] !== undefined, [sessionId]),
  )
  const onScreen = useEnvironmentState(
    useCallback((state: EnvironmentState) => state.activeSessionId === sessionId, [sessionId]),
  )
  const failure = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        state.sessionOpenFailure?.sessionId === sessionId ? state.sessionOpenFailure.message : null,
      [sessionId],
    ),
  )
  const [missing, setMissing] = useState(false)
  // An open this page has on its way. Until its answer, a session the list
  // has not reached yet is not the active one, and a reconnect would not
  // open it again; a failed attempt clears this, so the next connect does.
  const openingRef = useRef<string | null>(null)
  const knownRef = useRef(false)

  const open = useCallback(() => {
    openingRef.current = sessionId
    client.commands.openSession(sessionId).then(
      () => {
        if (openingRef.current === sessionId) openingRef.current = null
      },
      (error: unknown) => {
        if (openingRef.current !== sessionId) return
        openingRef.current = null
        if (isEnvironmentClientError(error) && error.code === 'not_found') setMissing(true)
      },
    )
  }, [client, sessionId])

  // Leaving the page, or this page showing another session, releases it,
  // if it is still this page's: another page may have taken it since.
  useEffect(() => {
    setMissing(false)
    knownRef.current = false
    return () => {
      const active = client.getState().activeSessionId
      const pending = openingRef.current === sessionId
      openingRef.current = null
      // An open still on its way lands nowhere once the selection moves.
      if (active === sessionId || (pending && active === null)) client.setActiveSession(null)
    }
  }, [client, sessionId])

  // Opened while this page is in front and the socket is up, unless it is
  // already the client's (the client opens its active session again itself
  // after a reconnect) or an open is on its way.
  useEffect(() => {
    if (!focused || !connected || !replays || onScreen || openingRef.current === sessionId) return
    open()
  }, [connected, focused, onScreen, open, replays, sessionId])

  // Deleted while on screen (here or on another device): the environment's
  // listing drops it, and the page says so rather than showing a stale copy.
  useEffect(() => {
    if (known) knownRef.current = true
    else if (knownRef.current) setMissing(true)
  }, [known, sessionId])

  const session = sessions.find((row) => row.externalId === sessionId)
  const workspace = session
    ? workspaces.find((entry) => entry.path === session.workspacePath)
    : undefined

  // Done means "finished and not looked at yet": having it on screen while the
  // app is in front clears it, on the environment. A failed clear leaves the
  // mark, and the next open tries again.
  const acknowledge = sidebar?.acknowledgeSessionDone
  const doneOnScreen = focused && onScreen && activity === 'active' && session?.status === 'done'
  // Once per listing of it as done: a new provider value while the answer is
  // on its way asks nothing twice.
  const acknowledgedRef = useRef<HomeSession | null>(null)
  useEffect(() => {
    if (!doneOnScreen || !acknowledge || !session || acknowledgedRef.current === session) return
    acknowledgedRef.current = session
    acknowledge(session.workspacePath, session.externalId, session.providerId).catch(
      () => undefined,
    )
  }, [acknowledge, doneOnScreen, session])

  const mine = onScreen && thread.activeSessionId === sessionId
  const phase: ReadOnlySessionPhase = missing
    ? 'gone'
    : connected && !replays
      ? 'unsupported'
      : failure !== null || (mine && thread.history?.failed)
        ? 'failed'
        : !mine || thread.isMessagesLoading
          ? 'opening'
          : 'ready'

  return {
    session,
    workspace,
    title: mine ? thread.activeThread?.title : undefined,
    messages: mine ? thread.messages : NO_MESSAGES,
    phase,
    failure,
    retry: replays ? open : noop,
  }
}
