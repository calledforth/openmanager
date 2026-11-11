import type { PullRequestDetail, PullRequestSummary } from '@openmanager/protocol'

/** Fixtures are dated against a fixed "now", so the ages read the same in every shot. */
export const FIXTURE_NOW = Date.parse('2026-11-10T15:00:00Z')

const at = (hoursAgo: number) => new Date(FIXTURE_NOW - hoursAgo * 3_600_000).toISOString()

const avatar = (seed: string) =>
  `https://api.dicebear.com/9.x/thumbs/svg?seed=${seed}&backgroundType=gradientLinear&radius=50`

const REPO = 'calledforth/openmanager'
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`

export const BODY_FULL = `## Summary

Links GitHub pull requests to a session. The agent links one with the \`link_pull_request\` MCP tool, or the environment picks up the one \`gh pr create\` printed; the environment reads it with its own \`gh\` login and keeps it fresh.

Closes [CAL-344](https://linear.app/calledforth/issue/CAL-344) and the follow-up in #298.

### What changed

- **Protocol** — \`PullRequestSummary\` rides on \`SessionSummary.pullRequests\`; \`pull_request.get\` is a capability a client checks before asking.
- **Environment** — polls \`gh pr view --json\` every two minutes while the session is open, and once more when it is reopened.
- **Web** — a pill at the right of the chat topbar and a panel that shows the selected pull request.

### Checklist

- [x] Migration 30 (\`session_pull_requests\`)
- [x] Server tests for the link/unlink round trip
- [ ] Mobile reads the summaries (CAL-349)

\`\`\`ts
const summary = PullRequestSummarySchema.parse(await gh.view(repository, number))
sessions.linkPullRequest(sessionId, summary)
\`\`\`

| Field | Source | Refresh |
| --- | --- | --- |
| \`state\`, \`checks\` | \`gh pr view\` | 2 min |
| \`body\` | \`gh pr view --json body\` | on open |
| \`checkRuns\` | \`gh pr checks\` | on open |

See the [GitHub CLI manual](https://cli.github.com/manual/gh_pr_view) for the fields \`gh pr view\` exposes.
`

export const BODY_SHORT = `Drops the Convex-era \`useQuery\` wrappers from the phone app and reads the session list over the environment socket, the way the web already does.

- Removes \`convex/react\` from \`apps/mobile\`
- \`SessionList\` takes \`sessions\` as a prop

No visual change.`

export const OPEN_PASSING: PullRequestDetail = {
  url: url(301),
  repository: REPO,
  number: 301,
  linkedAt: at(5),
  title: 'Link GitHub pull requests to a session',
  state: 'open',
  labels: [
    { name: 'feature', color: 'a2eeef' },
    { name: 'web', color: '0e8a16' },
    { name: 'needs review', color: 'fbca04' },
  ],
  checks: 'passing',
  reviewDecision: 'approved',
  additions: 1_204,
  deletions: 188,
  updatedAt: at(0.4),
  syncedAt: at(0.05),
  problem: null,
  body: BODY_FULL,
  author: { login: 'calledforth', avatarUrl: avatar('calledforth') },
  headRef: 'feat/pr-linking',
  baseRef: 'main',
  createdAt: at(26),
  mergedAt: null,
  closedAt: null,
  changedFiles: 23,
  commits: 9,
  reviewers: [
    { login: 'gpt-reviewer', avatarUrl: avatar('gpt'), state: 'approved' },
    { login: 'rajku', avatarUrl: null, state: 'commented' },
  ],
  checkRuns: [
    { name: 'Typecheck', state: 'success', url: `${url(301)}/checks?check_run_id=1` },
    { name: 'Lint', state: 'success', url: `${url(301)}/checks?check_run_id=2` },
    { name: 'Tests · ubuntu', state: 'success', url: `${url(301)}/checks?check_run_id=3` },
    { name: 'Tests · windows', state: 'success', url: `${url(301)}/checks?check_run_id=4` },
    { name: 'Prettier', state: 'success', url: `${url(301)}/checks?check_run_id=5` },
    { name: 'Workers Builds', state: 'skipped', url: null },
  ],
}

export const DRAFT_FAILING: PullRequestDetail = {
  url: url(304),
  repository: REPO,
  number: 304,
  linkedAt: at(2),
  title: 'Mobile: read linked pull requests from the session summary',
  state: 'draft',
  labels: [{ name: 'mobile', color: '5319e7' }],
  checks: 'failing',
  reviewDecision: 'review_required',
  additions: 412,
  deletions: 37,
  updatedAt: at(0.2),
  syncedAt: at(0.05),
  problem: null,
  body: BODY_SHORT,
  author: { login: 'calledforth', avatarUrl: avatar('calledforth') },
  headRef: 'feat/mobile-pr-summaries',
  baseRef: 'feat/pr-linking',
  createdAt: at(3),
  mergedAt: null,
  closedAt: null,
  changedFiles: 7,
  commits: 2,
  reviewers: [{ login: 'gpt-reviewer', avatarUrl: avatar('gpt'), state: 'requested' }],
  checkRuns: [
    { name: 'Typecheck', state: 'success', url: `${url(304)}/checks?check_run_id=1` },
    { name: 'Lint', state: 'failure', url: `${url(304)}/checks?check_run_id=2` },
    { name: 'Tests · ubuntu', state: 'failure', url: `${url(304)}/checks?check_run_id=3` },
    { name: 'Tests · windows', state: 'pending', url: `${url(304)}/checks?check_run_id=4` },
    { name: 'Android APK', state: 'pending', url: null },
  ],
}

export const MERGED: PullRequestDetail = {
  url: url(298),
  repository: REPO,
  number: 298,
  linkedAt: at(70),
  title: 'Search what was said in chats, across every environment',
  state: 'merged',
  labels: [
    { name: 'feature', color: 'a2eeef' },
    { name: 'server', color: '1d1d1d' },
    { name: 'protocol', color: 'f9d0c4' },
  ],
  checks: 'passing',
  reviewDecision: 'approved',
  additions: 2_318,
  deletions: 241,
  updatedAt: at(48),
  syncedAt: at(0.1),
  problem: null,
  body: `## Summary

Full-text search over every message, in every environment the client knows. \`⌘⇧F\` opens the palette; results group by session and open the message in place.

### Notes

- FTS5 virtual table in migration 29, kept in step by triggers on \`messages\`.
- \`search.messages\` needs no protocol bump: it is a capability.
- The palette debounces 120 ms and cancels the previous request.

See the [design notes](https://linear.app/calledforth/issue/CAL-340) for the ranking.`,
  author: { login: 'calledforth', avatarUrl: avatar('calledforth') },
  headRef: 'feat/message-search',
  baseRef: 'main',
  createdAt: at(96),
  mergedAt: at(48),
  closedAt: at(48),
  changedFiles: 31,
  commits: 14,
  reviewers: [
    { login: 'gpt-reviewer', avatarUrl: avatar('gpt'), state: 'approved' },
    { login: 'opus-reviewer', avatarUrl: avatar('opus'), state: 'approved' },
  ],
  checkRuns: [
    { name: 'Typecheck', state: 'success', url: null },
    { name: 'Lint', state: 'success', url: null },
    { name: 'Tests · ubuntu', state: 'success', url: null },
    { name: 'Tests · windows', state: 'success', url: null },
  ],
}

export const CLOSED: PullRequestDetail = {
  url: url(287),
  repository: REPO,
  number: 287,
  linkedAt: at(200),
  title: 'Try a service worker for session notifications',
  state: 'closed',
  labels: [{ name: 'wontfix', color: 'ffffff' }],
  checks: 'passing',
  reviewDecision: 'changes_requested',
  additions: 96,
  deletions: 12,
  updatedAt: at(180),
  syncedAt: at(0.1),
  problem: null,
  body: `Superseded by the socket-driven notices in #179. Closing without merging.`,
  author: { login: 'calledforth', avatarUrl: avatar('calledforth') },
  headRef: 'spike/service-worker',
  baseRef: 'main',
  createdAt: at(220),
  mergedAt: null,
  closedAt: at(180),
  changedFiles: 4,
  commits: 1,
  reviewers: [{ login: 'rajku', avatarUrl: null, state: 'changes_requested' }],
  checkRuns: [{ name: 'Typecheck', state: 'success', url: null }],
}

/** Eleven labels across the hue wheel, with the two that fail naive rendering (near-black, white). */
export const MANY_LABELS: PullRequestDetail = {
  ...OPEN_PASSING,
  number: 302,
  url: url(302),
  title: 'Theme families: Carbon and Claude-ish, light and dark',
  labels: [
    { name: 'bug', color: 'd73a4a' },
    { name: 'documentation', color: '0075ca' },
    { name: 'duplicate', color: 'cfd3d7' },
    { name: 'enhancement', color: 'a2eeef' },
    { name: 'good first issue', color: '7057ff' },
    { name: 'help wanted', color: '008672' },
    { name: 'invalid', color: 'e4e669' },
    { name: 'question', color: 'd876e3' },
    { name: 'wontfix', color: 'ffffff' },
    { name: 'server', color: '1d1d1d' },
    { name: 'design: needs a look', color: 'ff7b72' },
  ],
  checks: 'pending',
  reviewDecision: 'review_required',
  checkRuns: [
    { name: 'Typecheck', state: 'success', url: null },
    { name: 'Lint', state: 'pending', url: null },
    { name: 'Tests · ubuntu', state: 'pending', url: null },
    { name: 'Chromatic', state: 'neutral', url: null },
  ],
}

const summaryOf = (d: PullRequestDetail): PullRequestSummary => ({
  url: d.url,
  repository: d.repository,
  number: d.number,
  linkedAt: d.linkedAt,
  title: d.title,
  state: d.state,
  labels: d.labels,
  checks: d.checks,
  reviewDecision: d.reviewDecision,
  additions: d.additions,
  deletions: d.deletions,
  updatedAt: d.updatedAt,
  syncedAt: d.syncedAt,
  problem: d.problem,
})

export const SUMMARY_OPEN = summaryOf(OPEN_PASSING)
export const SUMMARY_DRAFT = summaryOf(DRAFT_FAILING)
export const SUMMARY_MERGED = summaryOf(MERGED)
export const SUMMARY_CLOSED = summaryOf(CLOSED)
export const SUMMARY_MANY_LABELS = summaryOf(MANY_LABELS)

/** Linked, never read: the environment has not reached GitHub for it yet. */
export const SUMMARY_NEVER_READ: PullRequestSummary = {
  url: url(305),
  repository: REPO,
  number: 305,
  linkedAt: at(0.01),
  title: null,
  state: null,
  labels: [],
  checks: null,
  reviewDecision: null,
  additions: null,
  deletions: null,
  updatedAt: null,
  syncedAt: null,
  problem: null,
}

export const SUMMARY_NOT_SIGNED_IN: PullRequestSummary = {
  ...SUMMARY_NEVER_READ,
  problem: 'not_signed_in',
}

export const SUMMARY_NOT_FOUND: PullRequestSummary = {
  ...SUMMARY_NEVER_READ,
  number: 9_999,
  url: url(9_999),
  problem: 'not_found',
}

/** Read once, then GitHub went away: the last values stay, with a notice. */
export const SUMMARY_UNREACHABLE: PullRequestSummary = {
  ...SUMMARY_OPEN,
  syncedAt: at(3),
  problem: 'unreachable',
}

export const DETAIL_UNREACHABLE: PullRequestDetail = {
  ...OPEN_PASSING,
  syncedAt: at(3),
  problem: 'unreachable',
}

export const FOUR: PullRequestSummary[] = [
  SUMMARY_MERGED,
  SUMMARY_OPEN,
  SUMMARY_DRAFT,
  SUMMARY_CLOSED,
]

export const DETAILS: Record<string, PullRequestDetail> = Object.fromEntries(
  [OPEN_PASSING, DRAFT_FAILING, MERGED, CLOSED, MANY_LABELS, DETAIL_UNREACHABLE].map((d) => [
    `${d.repository}#${d.number}`,
    d,
  ]),
)
