import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowRightIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
  FilesIcon,
  GitBranchIcon,
  GitCommitIcon,
  GithubLogoIcon,
  SignInIcon,
  WarningCircleIcon,
  WifiSlashIcon,
} from '@phosphor-icons/react'
import type {
  PullRequestCheckRun,
  PullRequestDetail,
  PullRequestLabel,
  PullRequestPerson,
  PullRequestReviewer,
  PullRequestSummary,
} from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { useNow } from '../../lib/relative-time'
import { spring } from '../fluid/lib/springs'
import { Tooltip } from '../fluid/ui/tooltip'
import { Markdown } from '../markdown/Markdown'
import {
  CHECK_RUN,
  PR_CHECKS,
  REVIEWER_STATE,
  REVIEW_DECISION,
  ago,
  count,
  labelStyle,
  stateMeta,
} from './pull-request-status'

export interface PullRequestDetailViewProps {
  /** What every client holds: enough for the header at once. */
  summary: PullRequestSummary
  /** The full read, when the client has it. Null while loading or refused. */
  detail: PullRequestDetail | null
  loading?: boolean
  /** Why `pull_request.get` failed, if it did; the summary still shows. */
  error?: string | null
  onOpenOnGitHub: (url: string) => void
  /** Names the machine `gh` runs on, in the not-signed-in notice. */
  environmentLabel?: string | null
  className?: string
}

/**
 * One pull request, laid out the way Linear lays out a record: the title with
 * its identifier above, a short line of state and size, then a property list
 * (label on the left, value on the right) and the description under it. No
 * rules between sections; spacing and the muted labels carry the structure.
 */
export function PullRequestDetailView({
  summary,
  detail,
  loading = false,
  error = null,
  onOpenOnGitHub,
  environmentLabel,
  className,
}: PullRequestDetailViewProps) {
  const now = useNow()
  // The summary is always the freshest word on state and counts; the detail
  // adds what the summary lacks.
  const pr = detail && sameRecord(detail, summary) ? { ...detail, ...summary } : null
  const meta = stateMeta(summary.state)
  const neverRead = summary.title === null
  const title = summary.title ?? `Pull request #${summary.number}`

  return (
    <article className={cn('flex min-w-0 flex-col gap-5', className)}>
      <ProblemNotice summary={summary} environmentLabel={environmentLabel} now={now} />

      {/* ── Identity ── */}
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[var(--basis-text-muted)]">
          <GithubLogoIcon size={13} weight="fill" aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate text-11-medium leading-none">
            {summary.repository}
            <span className="text-[var(--basis-text-faint)]"> #{summary.number}</span>
          </span>
          <span className="flex-1" />
          <Tooltip content="Open on GitHub" side="bottom">
            <button
              type="button"
              aria-label="Open on GitHub"
              onClick={() => onOpenOnGitHub(summary.url)}
              className="-m-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-colors duration-150 hover:bg-hover hover:text-[var(--basis-text-strong)] focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ArrowSquareOutIcon size={14} aria-hidden />
            </button>
          </Tooltip>
        </div>
        <h2
          className={cn(
            'text-[15px] leading-[1.35] font-medium tracking-[-0.005em] text-[var(--basis-text-strong)] [overflow-wrap:anywhere]',
            neverRead && 'text-[var(--basis-text-muted)]',
          )}
        >
          {title}
        </h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StateChip state={summary.state} />
          <Diffstat additions={summary.additions} deletions={summary.deletions} />
          {pr?.changedFiles != null || pr?.commits != null ? (
            <span className="flex items-center gap-2.5 text-11-regular leading-none text-[var(--basis-text-muted)] tabular-nums">
              {pr.changedFiles != null ? (
                <span className="flex items-center gap-1">
                  <FilesIcon size={12} aria-hidden />
                  {count(pr.changedFiles)} {pr.changedFiles === 1 ? 'file' : 'files'}
                </span>
              ) : null}
              {pr.commits != null ? (
                <span className="flex items-center gap-1">
                  <GitCommitIcon size={12} aria-hidden />
                  {count(pr.commits)} {pr.commits === 1 ? 'commit' : 'commits'}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </header>

      {/* ── Properties ── */}
      {pr ? (
        <PropertyList pr={pr} now={now} meta={meta} onOpenOnGitHub={onOpenOnGitHub} />
      ) : loading || (neverRead && !summary.problem) ? (
        <PropertySkeleton labels={summary.labels} />
      ) : error ? (
        <p className="text-12-regular text-[var(--basis-text-muted)]">
          Couldn’t read the full pull request: {error}
        </p>
      ) : summary.labels.length > 0 ? (
        <Property label="Labels">
          <Labels labels={summary.labels} />
        </Property>
      ) : null}

      {/* ── Description ── */}
      {pr ? (
        <section className="flex min-w-0 flex-col gap-2">
          <SectionLabel>Description</SectionLabel>
          {pr.body.trim() ? (
            // The body's own headings stay under the pull request's title.
            <Markdown className="text-[13px] leading-[1.6] [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13px] [&_h4]:text-[13px]">
              {pr.body}
            </Markdown>
          ) : (
            <p className="text-12-regular text-[var(--basis-text-faint)]">No description.</p>
          )}
        </section>
      ) : loading ? (
        <section className="flex flex-col gap-2">
          <SectionLabel>Description</SectionLabel>
          <BodySkeleton />
        </section>
      ) : null}
    </article>
  )
}

function sameRecord(a: PullRequestSummary, b: PullRequestSummary) {
  return a.repository === b.repository && a.number === b.number
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/** The state as a small filled chip: glyph and word on the state's own wash. */
export function StateChip({
  state,
  size = 'default',
}: {
  state: PullRequestSummary['state']
  size?: 'default' | 'compact'
}) {
  const meta = stateMeta(state)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full font-medium',
        size === 'compact' ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-5 px-2 text-[11px]',
      )}
      style={{ color: meta.color, backgroundColor: meta.wash }}
    >
      <meta.Icon size={size === 'compact' ? 11 : 12} weight="bold" aria-hidden />
      <span className="leading-none">{meta.label}</span>
    </span>
  )
}

export function Diffstat({
  additions,
  deletions,
  className,
}: {
  additions: number | null
  deletions: number | null
  className?: string
}) {
  if (additions == null && deletions == null) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-11-medium leading-none tabular-nums',
        className,
      )}
    >
      <span style={{ color: 'var(--basis-status-done)' }}>+{count(additions ?? 0)}</span>
      <span style={{ color: 'var(--basis-status-error)' }}>−{count(deletions ?? 0)}</span>
    </span>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-11-medium leading-none text-[var(--basis-text-muted)]">{children}</h3>
}

/**
 * One row of the property list: a fixed-width muted label, then the value.
 * Every value's first line is 20px tall (chips, branch names, avatars, the
 * checks button), and the label's line box matches, so a label sits on the
 * first line whether the value wraps to one line or four.
 */
function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="w-[72px] shrink-0 text-[12px] leading-5 text-[var(--basis-text-muted)]">
        {label}
      </span>
      <div className="flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-12-regular text-[var(--basis-text)]">
        {children}
      </div>
    </div>
  )
}

function PropertyList({
  pr,
  now,
  meta,
  onOpenOnGitHub,
}: {
  pr: PullRequestDetail
  now: number
  meta: ReturnType<typeof stateMeta>
  onOpenOnGitHub: (url: string) => void
}) {
  const when =
    pr.state === 'merged' && pr.mergedAt
      ? `merged ${ago(pr.mergedAt, now)}`
      : pr.state === 'closed' && pr.closedAt
        ? `closed ${ago(pr.closedAt, now)}`
        : pr.createdAt
          ? `opened ${ago(pr.createdAt, now)}`
          : ''
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {pr.headRef || pr.baseRef ? (
        <Property label="Branch">
          <Branches head={pr.headRef} base={pr.baseRef} />
        </Property>
      ) : null}
      {pr.author || when ? (
        <Property label="Author">
          {pr.author ? <Person person={pr.author} /> : null}
          {when ? <span className="text-[var(--basis-text-muted)]">{when}</span> : null}
        </Property>
      ) : null}
      {pr.reviewDecision || pr.reviewers.length > 0 ? (
        <Property label="Review">
          <Review decision={pr.reviewDecision} reviewers={pr.reviewers} />
        </Property>
      ) : null}
      {pr.checks || pr.checkRuns.length > 0 ? (
        <Property label="Checks">
          <Checks summary={pr.checks} runs={pr.checkRuns} onOpen={onOpenOnGitHub} />
        </Property>
      ) : null}
      {pr.labels.length > 0 ? (
        <Property label="Labels">
          <Labels labels={pr.labels} />
        </Property>
      ) : null}
      {pr.updatedAt ? (
        <Property label="Updated">
          <span className="text-[var(--basis-text-muted)]" style={{ color: undefined }}>
            {ago(pr.updatedAt, now)}
            {pr.syncedAt ? (
              <span className="text-[var(--basis-text-faint)]">
                {' '}
                · read {ago(pr.syncedAt, now)}
              </span>
            ) : null}
          </span>
        </Property>
      ) : null}
      <span className="sr-only">{meta.label}</span>
    </div>
  )
}

function Branches({ head, base }: { head: string | null; base: string | null }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      {head ? <BranchName name={head} /> : null}
      {head && base ? (
        <ArrowRightIcon size={11} className="shrink-0 text-[var(--basis-text-faint)]" aria-hidden />
      ) : null}
      {base ? <BranchName name={base} /> : null}
    </span>
  )
}

function BranchName({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-5 min-w-0 items-center gap-1 rounded-md bg-hover px-1.5 font-mono text-[11px] text-[var(--basis-text)]"
      title={name}
    >
      <GitBranchIcon size={11} className="shrink-0 text-[var(--basis-text-faint)]" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** GitHub's avatar, or the login's initial when there is none or it won't load (offline, blocked). */
function Avatar({ person, size = 18 }: { person: PullRequestPerson; size?: number }) {
  const initial = person.login.slice(0, 1).toUpperCase()
  const [broken, setBroken] = useState(false)
  return person.avatarUrl && !broken ? (
    <img
      src={person.avatarUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      className="shrink-0 rounded-full bg-hover object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-active text-[9px] font-medium text-[var(--basis-text-muted)]"
      style={{ width: size, height: size }}
    >
      {initial}
    </span>
  )
}

function Person({ person }: { person: PullRequestPerson }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar person={person} />
      <span className="truncate text-[var(--basis-text-strong)]">{person.login}</span>
    </span>
  )
}

function Review({
  decision,
  reviewers,
}: {
  decision: PullRequestDetail['reviewDecision']
  reviewers: readonly PullRequestReviewer[]
}) {
  const d = decision ? REVIEW_DECISION[decision] : null
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {d ? (
        <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: d.color }}>
          <d.Icon size={13} weight="bold" aria-hidden />
          {d.label}
        </span>
      ) : null}
      {reviewers.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {reviewers.map((reviewer) => {
            const s = REVIEWER_STATE[reviewer.state]
            return (
              <li key={reviewer.login} className="inline-flex min-w-0 items-center gap-1.5">
                <span className="relative shrink-0">
                  <Avatar person={reviewer} />
                  <span
                    className="absolute -right-1 -bottom-1 flex size-[11px] items-center justify-center rounded-full bg-[var(--basis-canvas-bg)]"
                    aria-hidden
                  >
                    <s.Icon size={8} weight="bold" style={{ color: s.color }} />
                  </span>
                </span>
                <span className="truncate text-[var(--basis-text)]">{reviewer.login}</span>
                <span className="sr-only">{s.label}</span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function Checks({
  summary,
  runs,
  onOpen,
}: {
  summary: PullRequestDetail['checks']
  runs: readonly PullRequestCheckRun[]
  onOpen: (url: string) => void
}) {
  const [open, setOpen] = useState(summary === 'failing')
  const reduceMotion = useReducedMotion()
  const meta = summary ? PR_CHECKS[summary] : null
  const failed = runs.filter((r) => r.state === 'failure').length
  const passed = runs.filter((r) => r.state === 'success').length
  const detail =
    runs.length === 0
      ? ''
      : summary === 'failing'
        ? `${failed} of ${runs.length} failed`
        : summary === 'pending'
          ? `${passed} of ${runs.length} done`
          : `${runs.length} ${runs.length === 1 ? 'check' : 'checks'}`
  const expandable = runs.length > 0

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          '-mx-1.5 flex h-5 items-center gap-1.5 rounded-md px-1.5 text-left',
          expandable &&
            'cursor-pointer transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring',
        )}
      >
        {meta ? (
          <meta.Icon size={13} weight="bold" style={{ color: meta.color }} aria-hidden />
        ) : null}
        <span className="text-12-medium leading-none" style={{ color: meta?.color }}>
          {meta?.label ?? 'No checks'}
        </span>
        {detail ? (
          <span className="text-12-regular leading-none text-[var(--basis-text-muted)]">
            {detail}
          </span>
        ) : null}
        {expandable ? (
          <CaretRightIcon
            size={11}
            weight="bold"
            className={cn(
              'ml-0.5 text-[var(--basis-text-faint)] transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden
          />
        ) : null}
      </button>
      <AnimatePresence initial={false}>
        {open && expandable ? (
          <motion.ul
            key="runs"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={
              reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }
            }
            transition={reduceMotion ? { duration: 0 } : spring.moderate}
            className="flex flex-col overflow-hidden"
          >
            {runs.map((run, index) => {
              const s = CHECK_RUN[run.state]
              const Row = run.url ? 'button' : 'div'
              return (
                <li key={`${run.name}-${index}`} className={cn(index === 0 && 'pt-1.5')}>
                  <Row
                    {...(run.url
                      ? { type: 'button' as const, onClick: () => onOpen(run.url!) }
                      : {})}
                    className={cn(
                      'group/run -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 py-[3px] text-left',
                      run.url &&
                        'cursor-pointer transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring',
                    )}
                  >
                    <s.Icon
                      size={12}
                      weight="bold"
                      className={cn(
                        'shrink-0',
                        run.state === 'pending' && 'motion-safe:animate-pulse',
                      )}
                      style={{ color: s.color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-12-regular leading-none text-[var(--basis-text)]">
                      {run.name}
                    </span>
                    <span className="sr-only">{s.label}</span>
                    {run.url ? (
                      <ArrowSquareOutIcon
                        size={11}
                        className="shrink-0 text-[var(--basis-text-faint)] opacity-0 transition-opacity duration-150 group-hover/run:opacity-100 group-focus-visible/run:opacity-100"
                        aria-hidden
                      />
                    ) : null}
                  </Row>
                </li>
              )
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/**
 * GitHub labels in GitHub's colours, Linear's way: a dot and the name on a
 * faint tint of the colour, never white type on a solid block. The ink is
 * adjusted per colour-scheme (see `labelInk`), so a near-black label still
 * shows on the dark canvas and a pale yellow on the light one.
 */
export function Labels({
  labels,
  size = 'default',
}: {
  labels: readonly PullRequestLabel[]
  size?: 'default' | 'compact'
}) {
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
      {labels.map((label) => (
        <li
          key={label.name}
          style={labelStyle(label.color)}
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full font-medium',
            'bg-[color-mix(in_srgb,var(--pr-label)_12%,transparent)] text-[var(--basis-text)]',
            size === 'compact' ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-5 px-2 text-[11px]',
          )}
        >
          <span className="size-[7px] shrink-0 rounded-full bg-[var(--pr-label)]" aria-hidden />
          <span className="truncate leading-none">{label.name}</span>
        </li>
      ))}
    </ul>
  )
}

// ─── Problem notices ────────────────────────────────────────────────────────

function ProblemNotice({
  summary,
  environmentLabel,
  now,
}: {
  summary: PullRequestSummary
  environmentLabel?: string | null
  now: number
}) {
  if (!summary.problem) return null
  const machine = environmentLabel ? `on ${environmentLabel}` : 'on the environment’s machine'
  const lastRead = summary.syncedAt ? `Showing what was read ${ago(summary.syncedAt, now)}.` : null
  const notice = {
    not_signed_in: {
      Icon: SignInIcon,
      title: 'GitHub isn’t signed in',
      body: (
        <>
          Run{' '}
          <code className="rounded bg-[var(--active)] px-1 py-px font-mono text-[11px] text-[var(--basis-text-strong)]">
            gh auth login
          </code>{' '}
          {machine}, then this pull request will be read.{lastRead ? ` ${lastRead}` : ''}
        </>
      ),
    },
    not_found: {
      Icon: WarningCircleIcon,
      title: 'Not found on GitHub',
      body: `It may have been deleted, or the account signed in ${machine} can’t see it.${lastRead ? ` ${lastRead}` : ''}`,
    },
    unreachable: {
      Icon: WifiSlashIcon,
      title: 'GitHub couldn’t be reached',
      body: lastRead ?? 'The environment will try again.',
    },
  }[summary.problem]
  const tone = summary.problem === 'unreachable' ? 'muted' : 'warn'
  return (
    <div
      role="status"
      className={cn(
        'flex gap-2.5 rounded-lg px-3 py-2.5',
        tone === 'warn'
          ? 'bg-[color-mix(in_srgb,var(--basis-status-needs)_11%,transparent)]'
          : 'bg-hover',
      )}
    >
      <notice.Icon
        size={14}
        weight="bold"
        className="mt-px shrink-0"
        style={{
          color: tone === 'warn' ? 'var(--basis-status-needs)' : 'var(--basis-text-muted)',
        }}
        aria-hidden
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-12-medium leading-snug text-[var(--basis-text-strong)]">
          {notice.title}
        </span>
        <span className="text-12-regular leading-snug text-[var(--basis-text-muted)]">
          {notice.body}
        </span>
      </div>
    </div>
  )
}

// ─── Skeletons ──────────────────────────────────────────────────────────────

function Bone({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'block h-3 rounded-full bg-[var(--hover)] motion-safe:animate-pulse',
        className,
      )}
      aria-hidden
    />
  )
}

function PropertySkeleton({ labels }: { labels: readonly PullRequestLabel[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Loading">
      <Property label="Branch">
        <Bone className="h-5 w-36" />
      </Property>
      <Property label="Author">
        <Bone className="size-[18px] rounded-full" />
        <Bone className="w-20" />
      </Property>
      <Property label="Checks">
        <Bone className="w-24" />
      </Property>
      {labels.length > 0 ? (
        <Property label="Labels">
          <Labels labels={labels} />
        </Property>
      ) : null}
    </div>
  )
}

function BodySkeleton() {
  return (
    <div className="flex flex-col gap-2.5 pt-1" aria-hidden>
      <Bone className="w-[92%]" />
      <Bone className="w-[78%]" />
      <Bone className="w-[85%]" />
      <Bone className="mt-2 w-[40%]" />
      <Bone className="w-[88%]" />
      <Bone className="w-[64%]" />
    </div>
  )
}
