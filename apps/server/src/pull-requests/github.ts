import { execFile as nodeExecFile } from 'node:child_process'
import type {
  PullRequestCheckRun,
  PullRequestDetail,
  PullRequestProblem,
  PullRequestReviewer,
} from '@openmanager/protocol/node'
import type { PullRequestRef } from './url.ts'

/**
 * Reading pull requests from GitHub with the user's own `gh` login: no
 * GitHub App and no service in between. The token comes from `gh auth
 * token` (or `GITHUB_TOKEN` / `GH_TOKEN`), and every read is one GraphQL
 * request for any number of pull requests, made directly with fetch.
 */

/** Everything one read returns; the environment adds when it read it and the link. */
export type PullRequestRead = Omit<PullRequestDetail, 'linkedAt' | 'syncedAt' | 'problem'>

export type PullRequestReadResult = { read: PullRequestRead } | { problem: PullRequestProblem }

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql'

/**
 * Pull requests per GraphQL request. Each asks for up to 100 labels, 100
 * reviews, 100 review requests and 100 check contexts, about 400 nodes, so 25
 * stay far below GitHub's 500,000-node limit and cost one rate-limit point.
 */
export const GITHUB_BATCH_MAX = 25

/** `gh auth token` answers in well under a second; one that hangs is not signed in. */
const GH_TOKEN_TIMEOUT_MS = 10_000
/**
 * How long "no token" is believed before `gh` is asked again: the poller asks
 * every minute, and spawning `gh` each time to hear "not logged in" again is
 * waste. Signing in is noticed within this long.
 */
const NO_TOKEN_RETRY_MS = 60_000
/** A GitHub request that has not answered by then is `unreachable`. */
const GITHUB_TIMEOUT_MS = 20_000

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>

const defaultExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], options, (error, stdout) =>
      error ? reject(error) : resolve({ stdout: String(stdout) }),
    )
  })

/** The user's GitHub token, cached; `invalidate` after GitHub refuses it. */
export function createGitHubToken(
  deps: {
    execFile?: ExecFile
    env?: NodeJS.ProcessEnv
    now?: () => number
  } = {},
) {
  const execFile = deps.execFile ?? defaultExecFile
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  let cached: string | null | undefined
  let missingSince = 0
  let pending: Promise<string | null> | undefined

  const lookup = async (): Promise<string | null> => {
    try {
      const { stdout } = await execFile('gh', ['auth', 'token', '--hostname', 'github.com'], {
        timeout: GH_TOKEN_TIMEOUT_MS,
        windowsHide: true,
      })
      const token = stdout.trim()
      if (token) return token
    } catch {
      // `gh` is missing, or not signed in: the environment variables may still say.
    }
    const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
    return fromEnv || null
  }

  return {
    async get(): Promise<string | null> {
      if (cached) return cached
      if (cached === null && now() - missingSince < NO_TOKEN_RETRY_MS) return null
      pending ??= lookup().finally(() => {
        pending = undefined
      })
      const token = await pending
      cached = token
      if (token === null) missingSince = now()
      return token
    },
    invalidate() {
      cached = undefined
    },
  }
}

export type GitHubToken = ReturnType<typeof createGitHubToken>

const PULL_REQUEST_FIELDS = `
  url title state isDraft merged body
  author { login avatarUrl }
  headRefName baseRefName additions deletions changedFiles
  commits { totalCount }
  createdAt updatedAt mergedAt closedAt reviewDecision
  labels(first: 100) { nodes { name color } }
  latestReviews(first: 100) { nodes { state author { login avatarUrl } } }
  reviewRequests(first: 100) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login avatarUrl }
        ... on Bot { login avatarUrl }
        ... on Mannequin { login avatarUrl }
        ... on Team { slug avatarUrl }
      }
    }
  }
  headCommit: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
`

/** One request for every ref, each under its own alias, with owner/name/number as variables. */
export function pullRequestQuery(refs: readonly PullRequestRef[]): {
  query: string
  variables: Record<string, string | number>
} {
  const declarations: string[] = []
  const selections: string[] = []
  const variables: Record<string, string | number> = {}
  refs.forEach((ref, index) => {
    const [owner, name] = ref.repository.split('/') as [string, string]
    declarations.push(`$o${index}: String!`, `$n${index}: String!`, `$p${index}: Int!`)
    selections.push(
      `pr${index}: repository(owner: $o${index}, name: $n${index}) { pullRequest(number: $p${index}) { ...PullRequestFields } }`,
    )
    variables[`o${index}`] = owner
    variables[`n${index}`] = name
    variables[`p${index}`] = ref.number
  })
  return {
    query: `query(${declarations.join(', ')}) {\n${selections.join('\n')}\n}\nfragment PullRequestFields on PullRequest {${PULL_REQUEST_FIELDS}}`,
    variables,
  }
}

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
const nodes = (value: unknown): Json[] =>
  Array.isArray(obj(value).nodes) ? (obj(value).nodes as unknown[]).map(obj) : []
const url = (value: unknown): string | null => {
  const text = str(value)
  if (!text || text.length > 2048) return null
  try {
    new URL(text)
    return text
  } catch {
    return null
  }
}
const timestamp = (value: unknown): string | null => {
  const text = str(value)
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null
}
// The protocol's bounds (pull-requests.ts), applied here so one odd pull
// request cannot make a whole session's summary fail to parse.
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)
const person = (value: unknown) => {
  const record = obj(value)
  const login = str(record.login) ?? str(record.slug)
  return login ? { login: clip(login, 256), avatarUrl: url(record.avatarUrl) } : null
}

const CHECK_ROLLUP: Record<string, PullRequestDetail['checks']> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
}
const CONCLUSION: Record<string, PullRequestCheckRun['state']> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMED_OUT: 'failure',
  CANCELLED: 'failure',
  ACTION_REQUIRED: 'failure',
  STARTUP_FAILURE: 'failure',
  NEUTRAL: 'neutral',
  STALE: 'neutral',
  SKIPPED: 'skipped',
}
const STATUS_STATE: Record<string, PullRequestCheckRun['state']> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
}
const REVIEW_STATE: Record<string, PullRequestReviewer['state'] | undefined> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
}
const DECISION: Record<string, PullRequestDetail['reviewDecision']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
}

/** One GraphQL `PullRequest` as the protocol states it. */
export function pullRequestFromGraphQL(ref: PullRequestRef, node: unknown): PullRequestRead {
  const pr = obj(node)
  const merged = pr.merged === true
  const state =
    merged || pr.state === 'MERGED'
      ? 'merged'
      : pr.state === 'CLOSED'
        ? 'closed'
        : pr.isDraft === true
          ? 'draft'
          : 'open'
  const rollup = obj(obj(nodes(pr.headCommit)[0]?.commit).statusCheckRollup)
  const checkRuns: PullRequestCheckRun[] = []
  for (const context of nodes(rollup.contexts)) {
    if (checkRuns.length >= 200) break
    if (context.__typename === 'CheckRun') {
      const name = str(context.name)
      if (!name) continue
      checkRuns.push({
        name: clip(name, 512),
        state:
          context.status !== 'COMPLETED'
            ? 'pending'
            : (CONCLUSION[str(context.conclusion) ?? ''] ?? 'neutral'),
        url: url(context.detailsUrl),
      })
    } else if (context.__typename === 'StatusContext') {
      const name = str(context.context)
      if (!name) continue
      checkRuns.push({
        name: clip(name, 512),
        state: STATUS_STATE[str(context.state) ?? ''] ?? 'pending',
        url: url(context.targetUrl),
      })
    }
  }
  const reviewers: PullRequestReviewer[] = []
  const seen = new Set<string>()
  for (const review of nodes(pr.latestReviews)) {
    const reviewState = REVIEW_STATE[str(review.state) ?? '']
    const author = person(review.author)
    if (!reviewState || !author || seen.has(author.login)) continue
    seen.add(author.login)
    reviewers.push({ ...author, state: reviewState })
  }
  for (const request of nodes(pr.reviewRequests)) {
    const reviewer = person(request.requestedReviewer)
    if (!reviewer || seen.has(reviewer.login)) continue
    seen.add(reviewer.login)
    reviewers.push({ ...reviewer, state: 'requested' })
  }
  return {
    url: url(pr.url) ?? ref.url,
    repository: ref.repository,
    number: ref.number,
    title: str(pr.title) === null ? null : clip(str(pr.title)!, 1024),
    state,
    labels: nodes(pr.labels)
      .flatMap((label) => {
        const name = str(label.name)
        const color = str(label.color)
        return name && color && /^[0-9a-fA-F]{6}$/.test(color)
          ? [{ name: clip(name, 256), color }]
          : []
      })
      .slice(0, 100),
    checks: CHECK_ROLLUP[str(rollup.state) ?? ''] ?? null,
    reviewDecision: DECISION[str(pr.reviewDecision) ?? ''] ?? null,
    additions: count(pr.additions),
    deletions: count(pr.deletions),
    updatedAt: timestamp(pr.updatedAt),
    body: clip(str(pr.body) ?? '', 262_144),
    author: person(pr.author),
    headRef: str(pr.headRefName) === null ? null : clip(str(pr.headRefName)!, 1024),
    baseRef: str(pr.baseRefName) === null ? null : clip(str(pr.baseRefName)!, 1024),
    createdAt: timestamp(pr.createdAt),
    mergedAt: timestamp(pr.mergedAt),
    closedAt: timestamp(pr.closedAt),
    changedFiles: count(pr.changedFiles),
    commits: count(obj(pr.commits).totalCount),
    reviewers: reviewers.slice(0, 100),
    checkRuns,
  }
}

/** A GraphQL answer, alias by alias. */
export function readResultsFromGraphQL(
  refs: readonly PullRequestRef[],
  body: unknown,
): PullRequestReadResult[] {
  const data = obj(obj(body).data)
  const errors = Array.isArray(obj(body).errors) ? (obj(body).errors as unknown[]).map(obj) : []
  return refs.map((ref, index) => {
    const alias = `pr${index}`
    const pullRequest = obj(data[alias]).pullRequest
    if (pullRequest && typeof pullRequest === 'object') {
      return { read: pullRequestFromGraphQL(ref, pullRequest) }
    }
    const error = errors.find((item) => Array.isArray(item.path) && item.path[0] === alias)
    // No error, or GitHub's own NOT_FOUND: there is no such pull request this login can see.
    if (!error || error.type === 'NOT_FOUND') return { problem: 'not_found' as const }
    return { problem: 'unreachable' as const }
  })
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Read pull requests from GitHub, batched; one result per ref, in order. */
export function createGitHubReader(deps: { token: GitHubToken; fetch?: Fetch }) {
  const fetchImpl: Fetch = deps.fetch ?? ((input, init) => fetch(input, init))

  const post = async (token: string, refs: readonly PullRequestRef[]) =>
    fetchImpl(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'openmanager',
      },
      body: JSON.stringify(pullRequestQuery(refs)),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })

  const readBatch = async (refs: readonly PullRequestRef[]): Promise<PullRequestReadResult[]> => {
    const all = (problem: PullRequestProblem) => refs.map(() => ({ problem }))
    let token = await deps.token.get()
    if (!token) return all('not_signed_in')
    try {
      let response = await post(token, refs)
      if (response.status === 401) {
        // A token gh has since replaced (re-login, rotation): read it again, once.
        deps.token.invalidate()
        token = await deps.token.get()
        if (!token) return all('not_signed_in')
        response = await post(token, refs)
        if (response.status === 401) {
          deps.token.invalidate()
          return all('not_signed_in')
        }
      }
      if (!response.ok) return all('unreachable')
      return readResultsFromGraphQL(refs, await response.json())
    } catch {
      return all('unreachable')
    }
  }

  return {
    async read(refs: readonly PullRequestRef[]): Promise<PullRequestReadResult[]> {
      const results: PullRequestReadResult[] = []
      for (let start = 0; start < refs.length; start += GITHUB_BATCH_MAX) {
        results.push(...(await readBatch(refs.slice(start, start + GITHUB_BATCH_MAX))))
      }
      return results
    },
  }
}

export type GitHubReader = ReturnType<typeof createGitHubReader>
