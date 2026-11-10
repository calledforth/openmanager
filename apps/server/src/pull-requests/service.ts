import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  PULL_REQUEST_GET_CAPABILITY,
  PULL_REQUESTS_PER_SESSION_MAX,
  ProofEventSchemas,
  PullRequestCommandSchemas,
  PullRequestResponseSchemas,
  type CommandEnvelope,
  type DurableEvent,
  type ProofEvent,
  type PullRequestDetail,
  type PullRequestProblem,
  type PullRequestSummary,
} from '@openmanager/protocol/node'
import type { AgentTool } from '@agentpack/runtime/node'
import { pullRequestLinkKey, type WriteOptions } from '../db/event-repository.ts'
import type { GitHubReader, PullRequestRead, PullRequestReadResult } from './github.ts'
import {
  parsePullRequestUrl,
  pullRequestCreatedBy,
  runsGhPrCreate,
  shellCommandOf,
  type PullRequestRef,
} from './url.ts'

export type PullRequestLinkSource = 'tool' | 'gh_pr_create'

/**
 * Freshness (decision E). GitHub's GraphQL budget is 5,000 points an hour per
 * user, and one batched read of up to 25 pull requests costs one point.
 *
 * - Open and draft pull requests are read every minute while any client is
 *   connected: twenty of them cost about 60 points an hour, about 1% of the
 *   budget, and nobody waits more than a minute to see a merge or a red check.
 * - One whose detail a client asked for in the last five minutes is somebody
 *   looking at it: every 20 seconds, so checks and reviews move while they watch.
 * - Merged and closed pull requests are done and are not read again, except
 *   when a client opens one whose copy is older than 15 seconds.
 * - With no client connected nobody would see a change, so nothing is read.
 */
export const POLL_INTERVAL_MS = 60_000
export const WATCHED_POLL_INTERVAL_MS = 20_000
export const WATCH_WINDOW_MS = 5 * 60_000
/** `pull_request.get` answers from the copy; one older than this is read again behind it. */
export const DETAIL_STALE_MS = 15_000
/** How often the poller looks for what is due: fine enough for the 20-second pace. */
const POLL_TICK_MS = 5_000

export const LINK_PULL_REQUEST_TOOL = 'link_pull_request'

const LINK_TOOL_DESCRIPTION =
  "Link a GitHub pull request to this OpenManager session so the user can follow it in the session's pull-request panel. " +
  'Call it right after you open a pull request, or when the user asks you to track one. Safe to call again.'

const PROBLEM_TEXT: Record<PullRequestProblem, string> = {
  not_signed_in: "gh is not signed in on the environment's machine",
  not_found: 'GitHub says it does not exist, or this login cannot see it',
  unreachable: 'GitHub could not be reached',
}

type LinkRow = {
  session_id: string
  repository: string
  number: number
  url: string
  linked_at: number
}
type CacheRow = {
  repository: string
  number: number
  url: string
  state: string | null
  detail_json: string | null
  synced_at: number | null
  changed_at: number | null
  problem: PullRequestProblem | null
  attempted_at: number | null
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
const keyOf = (ref: { repository: string; number: number }) => `${ref.repository}#${ref.number}`

/** The summary fields of a read, for the summary every client holds. */
function summaryOf(link: LinkRow, cache: CacheRow | undefined): PullRequestSummary {
  const read = cache?.detail_json ? (JSON.parse(cache.detail_json) as PullRequestRead) : undefined
  return {
    url: read?.url ?? link.url,
    repository: link.repository,
    number: link.number,
    linkedAt: new Date(link.linked_at).toISOString(),
    title: read?.title ?? null,
    state: read?.state ?? null,
    labels: read?.labels ?? [],
    checks: read?.checks ?? null,
    reviewDecision: read?.reviewDecision ?? null,
    additions: read?.additions ?? null,
    deletions: read?.deletions ?? null,
    updatedAt: read?.updatedAt ?? null,
    // When the values above were read: it moves only with them, so a poll
    // that finds nothing new writes nothing to the log.
    syncedAt: iso(cache?.changed_at ?? null),
    problem: cache?.problem ?? null,
  }
}

export type PullRequestServiceDeps = {
  database: DatabaseSync
  github: GitHubReader
  environmentId: () => string
  /** Commit events together; `options` carries each new link's source. */
  appendAtomic: (events: readonly ProofEvent[], options?: WriteOptions) => DurableEvent[]
  /** Commit whatever the batcher holds, so rows a command names exist. */
  flush: () => void
  /** Whether any client is connected: with none, nothing is polled. */
  anyClientConnected: () => boolean
  log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
  now?: () => number
}

/**
 * Pull requests linked to sessions: linking, the environment's copy of each
 * from GitHub, keeping it fresh, and `pull_request.get`. Every change a
 * client can see goes out as a `session.updated` that states the session's
 * whole list, for every session linking the pull request that changed.
 */
export function createPullRequestService(deps: PullRequestServiceDeps) {
  const { database } = deps
  const now = deps.now ?? Date.now
  const q = {
    sessionOfThread: database.prepare('SELECT session_id FROM threads WHERE thread_id = ?'),
    parentOf: database.prepare('SELECT parent_session_id FROM sessions WHERE session_id = ?'),
    linksOf: database.prepare(
      `SELECT session_id, repository, number, url, linked_at FROM session_pull_requests
       WHERE session_id = ? ORDER BY linked_at, rowid`,
    ),
    link: database.prepare(
      `SELECT session_id, repository, number, url, linked_at FROM session_pull_requests
       WHERE session_id = ? AND repository = ? AND number = ?`,
    ),
    // GitHub's names are case-insensitive: a second spelling is the same link.
    linkAnyCase: database.prepare(
      `SELECT session_id, repository, number, url, linked_at FROM session_pull_requests
       WHERE session_id = ? AND lower(repository) = lower(?) AND number = ?`,
    ),
    sessionsLinking: database.prepare(
      'SELECT DISTINCT session_id FROM session_pull_requests WHERE repository = ? AND number = ?',
    ),
    cache: database.prepare(
      `SELECT repository, number, url, state, detail_json, synced_at, changed_at, problem, attempted_at
       FROM pull_requests WHERE repository = ? AND number = ?`,
    ),
    // Host-private (I1): no client reads this table; the lists built from it
    // reach clients only as events.
    ensureCache: database.prepare(
      `INSERT INTO pull_requests (repository, number, url) VALUES (?, ?, ?)
       ON CONFLICT (repository, number) DO NOTHING`,
    ),
    recordProblem: database.prepare(
      'UPDATE pull_requests SET problem = ?, attempted_at = ? WHERE repository = ? AND number = ?',
    ),
    pollable: database.prepare(
      `SELECT p.repository, p.number, p.url, p.attempted_at FROM pull_requests p
       WHERE (p.state IS NULL OR p.state IN ('open', 'draft'))
         AND EXISTS (SELECT 1 FROM session_pull_requests l
                     WHERE l.repository = p.repository AND l.number = p.number)`,
    ),
    prune: database.prepare(
      `DELETE FROM pull_requests WHERE NOT EXISTS (
         SELECT 1 FROM session_pull_requests l
         WHERE l.repository = pull_requests.repository AND l.number = pull_requests.number)`,
    ),
  }
  // A read that worked: ?5 is when, ?6 whether it found anything new.
  const recordRead = database.prepare(
    `UPDATE pull_requests SET url = ?1, state = ?2, github_updated_at = ?3, detail_json = ?4,
       synced_at = ?5, changed_at = CASE WHEN ?6 = 1 THEN ?5 ELSE changed_at END,
       problem = NULL, attempted_at = ?5
     WHERE repository = ?7 AND number = ?8`,
  )

  const readCache = (ref: { repository: string; number: number }) =>
    q.cache.get(ref.repository, ref.number) as CacheRow | undefined

  /** The session a runtime thread belongs to, and the root above a sub-agent's. */
  const rootSessionOf = (sessionId: string): string | undefined => {
    let current = sessionId
    // A parent chain is short (a sub-agent of a sub-agent at most); the bound
    // only stops a corrupt cycle from spinning.
    for (let depth = 0; depth < 32; depth += 1) {
      const row = q.parentOf.get(current) as { parent_session_id: string | null } | undefined
      if (!row) return undefined
      if (!row.parent_session_id) return current
      current = row.parent_session_id
    }
    return undefined
  }
  const sessionOfThread = (threadId: string): string | undefined => {
    deps.flush()
    const row = q.sessionOfThread.get(threadId) as { session_id: string } | undefined
    return row ? rootSessionOf(row.session_id) : undefined
  }

  /** `session.updated` stating each session's whole list as the rows now say. */
  const listEvent = (sessionId: string, extra?: LinkRow): ProofEvent => {
    const links = q.linksOf.all(sessionId) as LinkRow[]
    if (extra) links.push(extra)
    return ProofEventSchemas['session.updated'].parse({
      type: 'event',
      name: 'session.updated',
      eventId: randomUUID(),
      timestamp: new Date(now()).toISOString(),
      scope: { type: 'environment', environmentId: deps.environmentId() },
      payload: {
        sessionId,
        pullRequests: links.map((link) => summaryOf(link, readCache(link))),
      },
    })
  }

  /** Tell every session linking these pull requests what they now hold. */
  const publishChanged = (refs: readonly PullRequestRef[]) => {
    const sessions = new Set<string>()
    for (const ref of refs) {
      for (const row of q.sessionsLinking.all(ref.repository, ref.number) as {
        session_id: string
      }[]) {
        sessions.add(row.session_id)
      }
    }
    if (sessions.size === 0) return
    try {
      deps.appendAtomic([...sessions].map((sessionId) => listEvent(sessionId)))
    } catch (error) {
      // The copy is kept; the next change restates each list whole.
      deps.log('error', 'pull request changes were not published', { reason: String(error) })
    }
  }

  // ------------------------------------------------------------- reading

  const inFlight = new Map<string, Promise<void>>()

  const applyResult = (ref: PullRequestRef, result: PullRequestReadResult): boolean => {
    const at = now()
    const cache = readCache(ref)
    if (!cache) return false
    if ('read' in result) {
      const detail = JSON.stringify(result.read)
      const changed = cache.detail_json !== detail
      recordRead.run(
        result.read.url,
        result.read.state,
        result.read.updatedAt === null ? null : Date.parse(result.read.updatedAt),
        detail,
        at,
        changed ? 1 : 0,
        ref.repository,
        ref.number,
      )
      return changed || cache.problem !== null
    }
    q.recordProblem.run(result.problem, at, ref.repository, ref.number)
    return cache.problem !== result.problem
  }

  /** Read these from GitHub now (joining reads already under way), and publish what changed. */
  const refresh = async (refs: readonly PullRequestRef[]): Promise<void> => {
    const waiting: Promise<void>[] = []
    const fresh: PullRequestRef[] = []
    for (const ref of refs) {
      const running = inFlight.get(keyOf(ref))
      if (running) waiting.push(running)
      else fresh.push(ref)
    }
    if (fresh.length > 0) {
      const read = (async () => {
        const results = await deps.github.read(fresh)
        const changed = fresh.filter((ref, index) => {
          try {
            return applyResult(ref, results[index]!)
          } catch (error) {
            deps.log('error', 'a pull request read was not kept', {
              pullRequest: keyOf(ref),
              reason: String(error),
            })
            return false
          }
        })
        publishChanged(changed)
      })().finally(() => {
        for (const ref of fresh) inFlight.delete(keyOf(ref))
      })
      for (const ref of fresh) inFlight.set(keyOf(ref), read)
      waiting.push(read)
    }
    await Promise.all(waiting)
  }

  // ------------------------------------------------------------- linking

  type LinkOutcome =
    | { kind: 'linked'; ref: PullRequestRef; sessionId: string }
    | { kind: 'already'; ref: PullRequestRef; sessionId: string }
    | { kind: 'full' }
    | { kind: 'no_session' }

  /**
   * Link a pull request to a session (its root, for a sub-agent's). Commits
   * at once with whatever the environment already knows of it; the read from
   * GitHub follows and publishes what it finds.
   */
  const link = (
    sessionId: string,
    ref: PullRequestRef,
    source: PullRequestLinkSource,
  ): LinkOutcome => {
    deps.flush()
    const root = rootSessionOf(sessionId)
    if (!root) return { kind: 'no_session' }
    const existing = q.linkAnyCase.get(root, ref.repository, ref.number) as LinkRow | undefined
    if (existing) {
      return {
        kind: 'already',
        ref: { repository: existing.repository, number: existing.number, url: existing.url },
        sessionId: root,
      }
    }
    if ((q.linksOf.all(root) as LinkRow[]).length >= PULL_REQUESTS_PER_SESSION_MAX) {
      return { kind: 'full' }
    }
    q.ensureCache.run(ref.repository, ref.number, ref.url)
    const row: LinkRow = {
      session_id: root,
      repository: ref.repository,
      number: ref.number,
      url: ref.url,
      linked_at: now(),
    }
    deps.appendAtomic([listEvent(root, row)], {
      pullRequestSources: { [pullRequestLinkKey(root, ref.repository, ref.number)]: source },
    })
    return { kind: 'linked', ref, sessionId: root }
  }

  const describe = (sessionId: string, ref: PullRequestRef) => {
    const row = q.link.get(sessionId, ref.repository, ref.number) as LinkRow | undefined
    const summary = row ? summaryOf(row, readCache(row)) : undefined
    const name = `${ref.repository}#${ref.number}`
    if (!summary) return name
    const parts = [name]
    if (summary.title) parts.push(`"${summary.title}"`)
    if (summary.state) parts.push(`(${summary.state})`)
    return parts.join(' ')
  }

  const linkTool: AgentTool = {
    name: LINK_PULL_REQUEST_TOOL,
    description: LINK_TOOL_DESCRIPTION,
    inputSchema: {
      url: z
        .string()
        .max(2048)
        .describe('The pull request URL, https://github.com/{owner}/{repo}/pull/{number}.'),
    },
    async call(input, context) {
      const url = typeof input.url === 'string' ? input.url : ''
      const ref = parsePullRequestUrl(url)
      if (!ref) {
        return {
          text: `"${url.slice(0, 200)}" is not a GitHub pull request URL. Pass one like https://github.com/{owner}/{repo}/pull/{number}.`,
          isError: true,
        }
      }
      const sessionId = sessionOfThread(context.threadId)
      if (!sessionId) {
        return { text: 'This session is not known to OpenManager any more.', isError: true }
      }
      const outcome = link(sessionId, ref, 'tool')
      if (outcome.kind === 'no_session') {
        return { text: 'This session is not known to OpenManager any more.', isError: true }
      }
      if (outcome.kind === 'full') {
        return {
          text: `This session already links ${PULL_REQUESTS_PER_SESSION_MAX} pull requests, the most one session lists. Nothing was linked.`,
          isError: true,
        }
      }
      // Read now so the answer can name it; a read already under way is joined.
      if (outcome.kind === 'linked' || !readCache(outcome.ref)?.synced_at) {
        await refresh([outcome.ref]).catch(() => undefined)
      }
      const problem = readCache(outcome.ref)?.problem
      const named = describe(outcome.sessionId, outcome.ref)
      const lead =
        outcome.kind === 'linked'
          ? `Linked ${named} to this session.`
          : `${named} was already linked to this session.`
      return {
        text: problem
          ? `${lead} The environment could not read it from GitHub (${problem}: ${PROBLEM_TEXT[problem]}); it keeps trying.`
          : lead,
      }
    },
  }

  /**
   * A tool call ran `gh pr create` and settled: link the pull request it
   * printed. Nothing else links on its own (see `runsGhPrCreate`).
   */
  const observeSettledTool = (args: { sessionId: string; output: string }) => {
    const ref = pullRequestCreatedBy(args.output)
    if (!ref) return
    try {
      const outcome = link(args.sessionId, ref, 'gh_pr_create')
      if (outcome.kind === 'linked') {
        deps.log('info', 'linked the pull request gh pr create opened', {
          sessionId: outcome.sessionId,
          pullRequest: keyOf(ref),
        })
        void refresh([ref]).catch(() => undefined)
      }
    } catch (error) {
      deps.log('error', 'the pull request gh pr create opened was not linked', {
        reason: String(error),
      })
    }
  }

  // ------------------------------------------------------------- polling

  /** When a client last asked for each one's detail. */
  const watched = new Map<string, number>()
  let polling = false

  const pollOnce = async (): Promise<void> => {
    if (polling || !deps.anyClientConnected()) return
    polling = true
    try {
      const at = now()
      for (const [key, askedAt] of watched) if (at - askedAt >= WATCH_WINDOW_MS) watched.delete(key)
      q.prune.run()
      const due = (
        q.pollable.all() as {
          repository: string
          number: number
          url: string
          attempted_at: number | null
        }[]
      ).filter((row) => {
        if (row.attempted_at === null) return true
        const pace = watched.has(keyOf(row)) ? WATCHED_POLL_INTERVAL_MS : POLL_INTERVAL_MS
        return at - row.attempted_at >= pace
      })
      if (due.length > 0) {
        await refresh(due.map(({ repository, number, url }) => ({ repository, number, url })))
      }
    } catch (error) {
      deps.log('warn', 'pull requests were not polled', { reason: String(error) })
    } finally {
      polling = false
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined

  // ------------------------------------------------------------- pull_request.get

  const detailOf = (link: LinkRow): PullRequestDetail => {
    const cache = readCache(link)
    const summary = summaryOf(link, cache)
    const read = cache?.detail_json ? (JSON.parse(cache.detail_json) as PullRequestRead) : undefined
    return {
      ...summary,
      // The latest read that worked, which may be after the summary's: a
      // client keeps this detail until the summary moves past it.
      syncedAt: iso(cache?.synced_at ?? null),
      body: read?.body ?? '',
      author: read?.author ?? null,
      headRef: read?.headRef ?? null,
      baseRef: read?.baseRef ?? null,
      createdAt: read?.createdAt ?? null,
      mergedAt: read?.mergedAt ?? null,
      closedAt: read?.closedAt ?? null,
      changedFiles: read?.changedFiles ?? null,
      commits: read?.commits ?? null,
      reviewers: read?.reviewers ?? [],
      checkRuns: read?.checkRuns ?? [],
    }
  }

  const get = async (requestId: string, payload: unknown) => {
    const parsed =
      PullRequestCommandSchemas[PULL_REQUEST_GET_CAPABILITY].shape.payload.safeParse(payload)
    if (!parsed.success) {
      return {
        type: 'error' as const,
        requestId,
        error: { code: 'validation' as const, message: 'Invalid pull request request.' },
      }
    }
    const { sessionId, repository, number } = parsed.data
    deps.flush()
    const row = q.link.get(sessionId, repository, number) as LinkRow | undefined
    if (!row) {
      return {
        type: 'error' as const,
        requestId,
        error: {
          code: 'not_found' as const,
          message: 'That pull request is not linked to this session.',
        },
      }
    }
    const ref: PullRequestRef = { repository, number, url: row.url }
    watched.set(keyOf(ref), now())
    const cache = readCache(ref)
    if (!cache?.detail_json) {
      // Never read in full: read it first, so the answer has something in it.
      await refresh([ref]).catch(() => undefined)
    } else if (cache.synced_at === null || now() - cache.synced_at > DETAIL_STALE_MS) {
      // Answer from the copy now; what the read finds arrives as `session.updated`.
      void refresh([ref]).catch(() => undefined)
    }
    return PullRequestResponseSchemas[PULL_REQUEST_GET_CAPABILITY].parse({
      type: 'response',
      requestId,
      payload: { pullRequest: detailOf(row) },
    })
  }

  return {
    tools: [linkTool] as readonly AgentTool[],
    link,
    refresh,
    pollOnce,
    observeSettledTool,
    /** Whether a settling tool call is one `observeSettledTool` wants. */
    wantsToolInput: (input: unknown) => {
      const command = shellCommandOf(input)
      return command !== undefined && runsGhPrCreate(command)
    },
    start() {
      timer ??= setInterval(() => void pollOnce(), POLL_TICK_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    dispatch(command: CommandEnvelope): Promise<unknown> | undefined {
      if (command.name !== PULL_REQUEST_GET_CAPABILITY) return undefined
      return get(command.requestId, (command as { payload?: unknown }).payload)
    },
  }
}

export type PullRequestService = ReturnType<typeof createPullRequestService>
