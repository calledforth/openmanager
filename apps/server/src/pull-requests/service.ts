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
  sameHead,
  shellCommandOf,
  type PullRequestRef,
  type ReportedPullRequest,
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

/**
 * How much earlier than the host saw `gh pr create` start GitHub may stamp
 * the pull request it opened and still count as opened by it. GitHub stamps
 * `createdAt` to the second, from its own clock, and this machine's may be a
 * few seconds off; 30 s covers both with room. A pull request somebody else
 * opened in those 30 s that is also the only one the command printed is not a
 * mistake worth guarding against.
 */
export const GH_PR_CREATE_CLOCK_SLACK_MS = 30_000

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
  github_updated_at: number | null
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
      `SELECT repository, number, url, state, github_updated_at, detail_json, synced_at,
              changed_at, problem, attempted_at
       FROM pull_requests WHERE repository = ? AND number = ?`,
    ),
    // Host-private (I1): no client reads this table; the lists built from it
    // reach clients only as events.
    ensureCache: database.prepare(
      `INSERT INTO pull_requests (repository, number, url) VALUES (?, ?, ?)
       ON CONFLICT (repository, number) DO NOTHING`,
    ),
    // The whole copy as one read left it (`nextCopy`).
    writeCopy: database.prepare(
      `UPDATE pull_requests SET url = ?, state = ?, github_updated_at = ?, detail_json = ?,
         synced_at = ?, changed_at = ?, problem = ?, attempted_at = ?
       WHERE repository = ? AND number = ?`,
    ),
    // A read whose change was not published: only the pace moves, so the
    // copy still differs from the read and the next one publishes it.
    recordAttempt: database.prepare(
      'UPDATE pull_requests SET attempted_at = ? WHERE repository = ? AND number = ?',
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

  /**
   * `session.updated` stating a session's whole list: its links, plus `extra`
   * when this event creates it, each summarised from `copies` where a write
   * is about to change the copy, else from the copy as it stands.
   */
  const listEvent = (
    sessionId: string,
    { extra, copies }: { extra?: LinkRow; copies?: ReadonlyMap<string, CacheRow> } = {},
  ): ProofEvent => {
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
        pullRequests: links.map((link) =>
          summaryOf(link, copies?.get(keyOf(link)) ?? readCache(link)),
        ),
      },
    })
  }

  /** One pull request's copy after a read, and whether a client would see the difference. */
  type CopyUpdate = { ref: PullRequestRef; row: CacheRow; visible: boolean }

  const nextCopy = (
    ref: PullRequestRef,
    cache: CacheRow,
    result: PullRequestReadResult,
    at: number,
  ): CopyUpdate => {
    if ('read' in result) {
      const detail = JSON.stringify(result.read)
      const changed = cache.detail_json !== detail
      return {
        ref,
        row: {
          ...cache,
          url: result.read.url,
          state: result.read.state,
          github_updated_at:
            result.read.updatedAt === null ? null : Date.parse(result.read.updatedAt),
          detail_json: detail,
          synced_at: at,
          // When a read last found something new: a poll that finds nothing
          // new restates nothing.
          changed_at: changed ? at : cache.changed_at,
          problem: null,
          attempted_at: at,
        },
        visible: changed || cache.problem !== null,
      }
    }
    return {
      ref,
      row: { ...cache, problem: result.problem, attempted_at: at },
      visible: cache.problem !== result.problem,
    }
  }

  const emptyCopy = (ref: PullRequestRef): CacheRow => ({
    repository: ref.repository,
    number: ref.number,
    url: ref.url,
    state: null,
    github_updated_at: null,
    detail_json: null,
    synced_at: null,
    changed_at: null,
    problem: null,
    attempted_at: null,
  })

  /**
   * Write these copies, and a new link if one is made, in one transaction
   * with the `session.updated` of every session that sees a difference: the
   * copy never holds a change no event has stated, so a write that fails
   * (it throws) leaves the copy as it was and the next read finds the change
   * again. A read that changes nothing a client sees writes the copy alone.
   */
  const commitCopies = (
    updates: readonly CopyUpdate[],
    newLink?: { row: LinkRow; source: PullRequestLinkSource },
  ) => {
    const copies = new Map(updates.map((update) => [keyOf(update.ref), update.row]))
    const sessions = new Set<string>()
    for (const update of updates) {
      if (!update.visible) continue
      for (const row of q.sessionsLinking.all(update.ref.repository, update.ref.number) as {
        session_id: string
      }[]) {
        sessions.add(row.session_id)
      }
    }
    const events: ProofEvent[] = []
    if (newLink) {
      sessions.delete(newLink.row.session_id)
      events.push(listEvent(newLink.row.session_id, { extra: newLink.row, copies }))
    }
    for (const sessionId of sessions) events.push(listEvent(sessionId, { copies }))
    const write = () => {
      if (newLink) {
        q.ensureCache.run(newLink.row.repository, newLink.row.number, newLink.row.url)
      }
      for (const { row } of updates) {
        q.writeCopy.run(
          row.url,
          row.state,
          row.github_updated_at,
          row.detail_json,
          row.synced_at,
          row.changed_at,
          row.problem,
          row.attempted_at,
          row.repository,
          row.number,
        )
      }
    }
    if (events.length === 0) {
      write()
      return
    }
    deps.appendAtomic(events, {
      alongside: write,
      ...(newLink
        ? {
            pullRequestSources: {
              [pullRequestLinkKey(
                newLink.row.session_id,
                newLink.row.repository,
                newLink.row.number,
              )]: newLink.source,
            },
          }
        : {}),
    })
  }

  // ------------------------------------------------------------- reading

  const inFlight = new Map<string, Promise<void>>()

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
        const at = now()
        const updates: CopyUpdate[] = []
        fresh.forEach((ref, index) => {
          const cache = readCache(ref)
          // Unlinked everywhere meanwhile and pruned: nothing to keep.
          if (cache) updates.push(nextCopy(ref, cache, results[index]!, at))
        })
        try {
          commitCopies(updates)
        } catch (error) {
          deps.log('error', 'pull request reads were not kept', {
            pullRequests: updates.map((update) => keyOf(update.ref)),
            reason: String(error),
          })
          // Keep the pace, and nothing else: the copy still differs from
          // what GitHub said, so the next read finds it and publishes it.
          for (const { ref } of updates) {
            try {
              q.recordAttempt.run(at, ref.repository, ref.number)
            } catch {
              // The database refuses writes too; the next tick tries again.
            }
          }
        }
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

  /** The root session a link from this session goes to, and its link to `ref` if it has one. */
  const linkTarget = (sessionId: string, ref: PullRequestRef) => {
    deps.flush()
    const root = rootSessionOf(sessionId)
    if (!root) return undefined
    const existing = q.linkAnyCase.get(root, ref.repository, ref.number) as LinkRow | undefined
    return { root, existing }
  }

  /**
   * Link a pull request to a session (its root, for a sub-agent's). Commits
   * at once with whatever the environment knows of it, or with `read` when
   * the caller has just read it from GitHub (written with the link, in the
   * same transaction); otherwise the read follows and publishes what it finds.
   */
  const link = (
    sessionId: string,
    ref: PullRequestRef,
    source: PullRequestLinkSource,
    read?: PullRequestReadResult,
  ): LinkOutcome => {
    const target = linkTarget(sessionId, ref)
    if (!target) return { kind: 'no_session' }
    const { root, existing } = target
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
    const row: LinkRow = {
      session_id: root,
      repository: ref.repository,
      number: ref.number,
      url: ref.url,
      linked_at: now(),
    }
    const updates = read ? [nextCopy(ref, readCache(ref) ?? emptyCopy(ref), read, now())] : []
    commitCopies(updates, { row, source })
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
   * Whether GitHub's read confirms that the command opened (or found) the
   * pull request it printed: it was created once the command had started, or
   * `gh` said one already existed for a branch and this is that branch's.
   */
  const confirms = (
    reported: ReportedPullRequest,
    result: PullRequestReadResult | undefined,
    startedAt: number,
  ): boolean => {
    if (!result || !('read' in result)) return false
    if (reported.existingHead !== null) return sameHead(reported.existingHead, result.read.headRef)
    const createdAt =
      result.read.createdAt === null ? Number.NaN : Date.parse(result.read.createdAt)
    return createdAt >= startedAt - GH_PR_CREATE_CLOCK_SLACK_MS
  }

  /**
   * A tool call ran `gh pr create` and settled: link the pull request it
   * printed, once GitHub confirms that command made it. Nothing else links
   * on its own (see `runsGhPrCreate`), and a link is made only after the
   * confirming read, with that read: a link nobody can remove must never be
   * a guess, so there is no window in which an unconfirmed one is visible
   * and no event retracting it. A read that fails (GitHub unreachable, `gh`
   * signed out) confirms nothing, and the agent can still link it with the
   * tool.
   */
  const observeSettledTool = async (args: {
    sessionId: string
    output: string
    /** When the host first saw the command, in ms. */
    startedAt: number
  }): Promise<void> => {
    const reported = pullRequestCreatedBy(args.output)
    if (!reported) return
    const { ref } = reported
    try {
      const target = linkTarget(args.sessionId, ref)
      if (!target || target.existing) return
      const [result] = await deps.github.read([ref])
      if (!confirms(reported, result, args.startedAt)) {
        deps.log('info', 'gh pr create printed a pull request it did not open; not linked', {
          sessionId: target.root,
          pullRequest: keyOf(ref),
          read: result && 'problem' in result ? result.problem : 'read',
        })
        return
      }
      const outcome = link(args.sessionId, ref, 'gh_pr_create', result)
      if (outcome.kind === 'linked') {
        deps.log('info', 'linked the pull request gh pr create opened', {
          sessionId: outcome.sessionId,
          pullRequest: keyOf(ref),
        })
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
      ...(read?.checkRunsTotal === undefined ? {} : { checkRunsTotal: read.checkRunsTotal }),
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
