import { z } from 'zod'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * Pull requests linked to a session. The agent links one with the
 * OpenManager MCP tool, or the environment links the one `gh pr create`
 * printed; the environment then reads it from GitHub with its own `gh`
 * login, keeps the result, and keeps it fresh. Clients only display it.
 *
 * Additive: the summaries ride on `SessionSummary.pullRequests` and on
 * `session.updated`, which an older client's non-strict object drops, and
 * `pull_request.get` is a capability a client checks before asking. So it
 * needs no protocol version of its own.
 */
export const PULL_REQUEST_GET_CAPABILITY = 'pull_request.get' as const

/**
 * The most pull requests one session lists. It bounds the size of a session
 * summary, which every client holds for every session; the tool tells the
 * agent when a session is full rather than dropping a link silently.
 */
export const PULL_REQUESTS_PER_SESSION_MAX = 100

/** GitHub's own cap on a body is 65,536 characters; this leaves room for UTF-16. */
export const PULL_REQUEST_BODY_MAX = 262_144

// Local, not imported from domains.ts: domains.ts imports this file.
const Timestamp = z.iso.datetime({ offset: true })

/** `draft` is an open pull request marked as a draft. */
export const PullRequestStateSchema = z.enum(['open', 'draft', 'merged', 'closed'])

/** A GitHub label, with GitHub's own colour (six hex digits, no `#`). */
export const PullRequestLabelSchema = z.object({
  name: z.string().min(1).max(256),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
})

/** The rollup of the head commit's checks. */
export const PullRequestChecksSchema = z.enum(['pending', 'passing', 'failing'])

/** GitHub's review decision for the pull request as a whole. */
export const PullRequestReviewDecisionSchema = z.enum([
  'approved',
  'changes_requested',
  'review_required',
])

/**
 * Why the environment could not read a linked pull request. The link stays;
 * the fields read from GitHub keep their last values (null if never read).
 */
export const PullRequestProblemSchema = z.enum([
  /** `gh` is missing or not signed in on the environment's machine. */
  'not_signed_in',
  /** GitHub says it does not exist, or this login cannot see it. */
  'not_found',
  /** GitHub could not be reached or answered with an error. */
  'unreachable',
])

/** What every client holds for each linked pull request. */
export const PullRequestSummarySchema = z.object({
  /** `https://github.com/{owner}/{name}/pull/{number}`. */
  url: z.string().url().max(2048),
  /** `owner/name`. */
  repository: z.string().min(3).max(256),
  number: z.number().int().positive(),
  /** When it was linked to this session. The list is in this order. */
  linkedAt: Timestamp,
  /** Null until the environment has read it from GitHub once. */
  title: z.string().max(1024).nullable(),
  state: PullRequestStateSchema.nullable(),
  labels: z.array(PullRequestLabelSchema).max(100),
  checks: PullRequestChecksSchema.nullable(),
  reviewDecision: PullRequestReviewDecisionSchema.nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  /**
   * GitHub's `updatedAt`. A client keeps a detail it fetched until the
   * summary's `updatedAt` moves past the detail's.
   */
  updatedAt: Timestamp.nullable(),
  /**
   * When the environment read the values above from GitHub. A later read
   * that finds nothing changed does not restate the summary (the event log
   * would grow with every poll), so this moves only with a change; a
   * detail from `pull_request.get` carries the latest read that worked.
   * A client keeps a detail until the summary's `syncedAt` moves past it.
   */
  syncedAt: Timestamp.nullable(),
  /** Set while the last read failed; cleared by the next one that works. */
  problem: PullRequestProblemSchema.nullable(),
})

export const PullRequestSummaryListSchema = z
  .array(PullRequestSummarySchema)
  .max(PULL_REQUESTS_PER_SESSION_MAX)

export const PullRequestPersonSchema = z.object({
  login: z.string().min(1).max(256),
  avatarUrl: z.string().url().max(2048).nullable(),
})

export const PullRequestReviewerSchema = PullRequestPersonSchema.extend({
  /** `requested` means asked for a review that has not been given yet. */
  state: z.enum(['approved', 'changes_requested', 'commented', 'requested']),
})

export const PullRequestCheckRunSchema = z.object({
  name: z.string().min(1).max(512),
  state: z.enum(['pending', 'success', 'failure', 'neutral', 'skipped']),
  url: z.string().url().max(2048).nullable(),
})

/** Everything the PR view shows. Read on demand; a client caches it. */
export const PullRequestDetailSchema = PullRequestSummarySchema.extend({
  /** The description as GitHub-flavoured markdown, unrendered. */
  body: z.string().max(PULL_REQUEST_BODY_MAX),
  author: PullRequestPersonSchema.nullable(),
  headRef: z.string().max(1024).nullable(),
  baseRef: z.string().max(1024).nullable(),
  createdAt: Timestamp.nullable(),
  mergedAt: Timestamp.nullable(),
  closedAt: Timestamp.nullable(),
  changedFiles: z.number().int().nonnegative().nullable(),
  commits: z.number().int().nonnegative().nullable(),
  reviewers: z.array(PullRequestReviewerSchema).max(100),
  checkRuns: z.array(PullRequestCheckRunSchema).max(200),
})

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

export const PullRequestCommandSchemas = {
  /**
   * One linked pull request in full. Answers from what the environment
   * holds; a pull request it has never read in full is read from GitHub
   * first. Fails with `not_found` when the pull request is not linked to
   * the session.
   */
  [PULL_REQUEST_GET_CAPABILITY]: command(
    PULL_REQUEST_GET_CAPABILITY,
    z.object({
      sessionId: z.string().min(1).max(256),
      repository: z.string().min(3).max(256),
      number: z.number().int().positive(),
    }),
  ),
} as const

export const PullRequestResponseSchemas = {
  [PULL_REQUEST_GET_CAPABILITY]: response(z.object({ pullRequest: PullRequestDetailSchema })),
} as const

export type PullRequestState = z.infer<typeof PullRequestStateSchema>
export type PullRequestLabel = z.infer<typeof PullRequestLabelSchema>
export type PullRequestChecks = z.infer<typeof PullRequestChecksSchema>
export type PullRequestReviewDecision = z.infer<typeof PullRequestReviewDecisionSchema>
export type PullRequestProblem = z.infer<typeof PullRequestProblemSchema>
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>
export type PullRequestPerson = z.infer<typeof PullRequestPersonSchema>
export type PullRequestReviewer = z.infer<typeof PullRequestReviewerSchema>
export type PullRequestCheckRun = z.infer<typeof PullRequestCheckRunSchema>
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>
export type PullRequestGetResult = z.infer<
  (typeof PullRequestResponseSchemas)[typeof PULL_REQUEST_GET_CAPABILITY]
>['payload']
