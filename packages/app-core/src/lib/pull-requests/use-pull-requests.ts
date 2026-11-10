import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  pullRequestDetailIsCurrent,
  pullRequestDetailKey,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import type { PullRequestDetail, PullRequestSummary } from '@openmanager/protocol'
import { useEnvironmentClientOptional } from '../../providers/environment-client'

/**
 * Pull requests linked to sessions, for the views to display. Everything here
 * reads what the environment stated: summaries from the session list (kept
 * current by `session.updated`), details from `getPullRequest`, whose answers
 * the client keeps in its state and so in the host's offline cache.
 */

const NO_PULL_REQUESTS: readonly PullRequestSummary[] = []
const subscribeToNothing = () => () => undefined

/**
 * While a detail is on screen it is asked for again this often, though the
 * environment answers from its copy: an ask is what tells the environment
 * somebody is looking (it reads a watched pull request every 20 seconds
 * instead of every minute, for five minutes after the last ask).
 */
export const PULL_REQUEST_WATCH_RENEW_MS = 4 * 60_000

/** The client of this environment, if the scope's client is it; null otherwise. */
function useScopedClient(environmentId: string | null): EnvironmentClient | null {
  const client = useEnvironmentClientOptional()
  const read = () => {
    if (!client) return null
    if (environmentId === null) return client
    return client.getState().environment?.environmentId === environmentId ? client : null
  }
  const matches = useSyncExternalStore(client?.subscribe ?? subscribeToNothing, read, read)
  return matches
}

function useClientSelector<T>(
  client: EnvironmentClient | null,
  select: (state: EnvironmentState) => T,
  fallback: T,
): T {
  const read = () => (client ? select(client.getState()) : fallback)
  return useSyncExternalStore(client?.subscribe ?? subscribeToNothing, read, read)
}

/**
 * A session's linked pull requests, oldest link first; empty when it has none.
 * `environmentId` null means the environment of the surrounding scope.
 */
export function useSessionPullRequests(
  environmentId: string | null,
  sessionId: string | null | undefined,
): readonly PullRequestSummary[] {
  const client = useScopedClient(environmentId)
  const select = useCallback(
    (state: EnvironmentState) =>
      (sessionId ? state.sessions[sessionId]?.pullRequests : undefined) ?? NO_PULL_REQUESTS,
    [sessionId],
  )
  return useClientSelector(client, select, NO_PULL_REQUESTS)
}

export interface PullRequestDetailState {
  /** The last detail the environment gave, possibly from before a reload. */
  detail: PullRequestDetail | undefined
  /** An ask is under way. A held `detail` stays shown meanwhile. */
  loading: boolean
  /** Why the last ask failed; null once one works. */
  error: string | null
}

/** One ask per pull request at a time, whichever views want it. */
const inFlight = new WeakMap<EnvironmentClient, Map<string, Promise<PullRequestDetail>>>()

function ask(
  client: EnvironmentClient,
  input: { sessionId: string; repository: string; number: number },
): Promise<PullRequestDetail> {
  let asks = inFlight.get(client)
  if (!asks) {
    asks = new Map()
    inFlight.set(client, asks)
  }
  const key = pullRequestDetailKey(input)
  const running = asks.get(key)
  if (running) return running
  const asked = client.commands.getPullRequest(input).finally(() => asks.delete(key))
  asks.set(key, asked)
  return asked
}

/**
 * One linked pull request in full. Asks the environment when nothing is held,
 * or when the session's summary says the environment has read something newer
 * than the held detail; otherwise shows the held detail without asking.
 */
export function usePullRequestDetail(
  environmentId: string | null,
  sessionId: string | null | undefined,
  repository: string | null | undefined,
  number: number | null | undefined,
): PullRequestDetailState {
  const client = useScopedClient(environmentId)
  const key = repository && number ? pullRequestDetailKey({ repository, number }) : null
  const selectSummary = useCallback(
    (state: EnvironmentState) =>
      sessionId && repository && number
        ? state.sessions[sessionId]?.pullRequests?.find(
            (item) => item.repository === repository && item.number === number,
          )
        : undefined,
    [sessionId, repository, number],
  )
  const selectDetail = useCallback(
    (state: EnvironmentState) => (key ? state.pullRequestDetails?.[key] : undefined),
    [key],
  )
  const summary = useClientSelector(client, selectSummary, undefined)
  const detail = useClientSelector(client, selectDetail, undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = client?.supports('getPullRequest') ?? false
  const current = summary ? pullRequestDetailIsCurrent(summary, detail) : true
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const fetchDetail = useCallback(() => {
    if (!client || !sessionId || !repository || !number) return
    setLoading(true)
    ask(client, { sessionId, repository, number }).then(
      () => {
        if (!mounted.current) return
        setLoading(false)
        setError(null)
      },
      (reason: unknown) => {
        if (!mounted.current) return
        setLoading(false)
        setError(reason instanceof Error ? reason.message : 'The pull request could not be read.')
      },
    )
  }, [client, sessionId, repository, number])

  const linked = summary !== undefined
  useEffect(() => {
    if (!supported || !linked || current) return
    fetchDetail()
  }, [supported, linked, current, fetchDetail])

  useEffect(() => {
    if (!supported || !linked) return
    const timer = setInterval(fetchDetail, PULL_REQUEST_WATCH_RENEW_MS)
    return () => clearInterval(timer)
  }, [supported, linked, fetchDetail])

  return { detail, loading, error }
}
