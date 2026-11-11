/**
 * Recognising GitHub pull requests: a URL an agent passes to
 * `link_pull_request`, and the one `gh pr create` prints.
 */

export type PullRequestRef = {
  /** `owner/name`, as GitHub spells it in the URL. */
  repository: string
  number: number
  /** `https://github.com/{owner}/{name}/pull/{number}`, nothing after it. */
  url: string
}

// GitHub's own rules: an owner is letters, digits and single hyphens; a
// repository name adds `.` and `_`. Anything else is not a GitHub URL.
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const NAME = '[A-Za-z0-9._-]{1,100}'
const PULL_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${OWNER})/(${NAME})/pull/(\\d{1,9})(?:[/?#].*)?$`,
  'i',
)

/** A pull request URL, tolerating what follows it (`/files`, `#…`, `?…`); or null. */
export function parsePullRequestUrl(text: string): PullRequestRef | null {
  const match = PULL_URL.exec(text.trim())
  if (!match) return null
  const [, owner, name, digits] = match
  const number = Number(digits)
  if (!Number.isSafeInteger(number) || number <= 0 || name === '.' || name === '..') return null
  const repository = `${owner}/${name!.replace(/\.git$/i, '')}`
  return { repository, number, url: `https://github.com/${repository}/pull/${number}` }
}

const keyOf = (ref: { repository: string; number: number }) =>
  `${ref.repository.toLowerCase()}#${ref.number}`

/** Whether two refs name the same pull request (GitHub names are case-insensitive). */
export const samePullRequest = (
  left: { repository: string; number: number },
  right: { repository: string; number: number },
) => keyOf(left) === keyOf(right)

/**
 * `gh pr create` as a command: `gh` at the start of the line or after a shell
 * separator, then `pr create`. Only this command links on its own: an agent
 * reads old pull requests all the time (`gh pr view`, `gh pr list`, logs), and
 * none of those is one it opened.
 */
const GH_PR_CREATE = /(?:^|[\s;&|(`'"])(?:[\w./\\:-]*[/\\])?gh(?:\.exe)?["']?\s+pr\s+create\b/i
/** `--dry-run` prints what it would send (the body too) and opens nothing. */
const DRY_RUN = /(?:^|\s)--dry-run(?:[=\s"']|$)/

/**
 * Whether a command runs `gh pr create` in a way that can open a pull
 * request: never with `--dry-run` anywhere in it.
 */
export function runsGhPrCreate(command: string): boolean {
  return GH_PR_CREATE.test(command) && !DRY_RUN.test(command)
}

/**
 * The shell command a tool call ran, from its input: `command` (Claude Code's
 * Bash, OpenCode's bash, Cursor's shell), as a string or an argv array.
 */
export function shellCommandOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  for (const key of ['command', 'cmd']) {
    const value = record[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
      return value.join(' ')
    }
  }
  return undefined
}

// gh's own words (pkg/cmd/pr/create): the head is `branch`, or `owner:branch`
// from a fork, quoted Go-style.
const ALREADY_EXISTS =
  /a pull request for branch "([^"\n]*)" into branch "[^"\n]*" already exists:?\s*(https?:\/\/\S+)/i
const URL_LINE = /^\s*(https?:\/\/(?:www\.)?github\.com\/\S+\/pull\/\d+)\s*$/gim

/** A pull request `gh pr create` reported, and how. */
export type ReportedPullRequest = {
  ref: PullRequestRef
  /**
   * The head `gh` named when it found one already open for the branch
   * (`branch` or `owner:branch`); null when it printed the URL of one it
   * opened.
   */
  existingHead: string | null
}

/**
 * The pull request `gh pr create` reported: the URL it prints on a line of
 * its own when it opened one, or the one after "a pull request for branch …
 * already exists:" when there was one. Only when the output names exactly
 * one pull request that way: a command that also lists or prints others
 * (`gh pr create --fill; gh pr list …`) cannot say which is the new one.
 * This is only a candidate; the caller confirms it with GitHub.
 */
export function pullRequestCreatedBy(output: string): ReportedPullRequest | null {
  const candidates: PullRequestRef[] = []
  const add = (ref: PullRequestRef | null) => {
    if (ref && !candidates.some((known) => samePullRequest(known, ref))) candidates.push(ref)
  }
  const existing = ALREADY_EXISTS.exec(output)
  const existingRef = existing ? parsePullRequestUrl(existing[2]!) : null
  add(existingRef)
  for (const match of output.matchAll(URL_LINE)) add(parsePullRequestUrl(match[1]!))
  if (candidates.length !== 1) return null
  const ref = candidates[0]!
  return {
    ref,
    existingHead:
      existing && existingRef && samePullRequest(existingRef, ref) ? existing[1]! : null,
  }
}

/** Whether `gh`'s head label (`branch` or `owner:branch`) names this head branch. */
export function sameHead(label: string, headRef: string | null): boolean {
  if (!headRef || !label) return false
  return label === headRef || label.endsWith(`:${headRef}`)
}
