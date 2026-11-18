import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretDownIcon, CaretLeftIcon, CaretUpIcon } from '@phosphor-icons/react'
import type { PullRequestDetail, PullRequestState, PullRequestSummary } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { useNow } from '../../lib/relative-time'
import { spring } from '../fluid/lib/springs'
import { Tooltip } from '../fluid/ui/tooltip'
import { Kbd } from '../side-panel/Kbd'
import { PanelSubheader, usePanelKeys } from '../side-panel/PanelDeck'
import { Diffstat, PullRequestDetailView } from './PullRequestDetailView'
import { PR_CHECKS, REVIEW_DECISION, ago, pullRequestKey, stateMeta } from './pull-request-status'

export interface PullRequestsPanelProps {
  pullRequests: readonly PullRequestSummary[]
  /**
   * `pullRequestKey(summary)` of the one open in full; null shows the list.
   * With a single pull request it is always open: there is no list to show.
   */
  openKey: string | null
  onOpen: (key: string | null) => void
  /** The open pull request in full, when the client has it. */
  detail: PullRequestDetail | null
  detailLoading?: boolean
  detailError?: string | null
  onOpenOnGitHub: (url: string) => void
  /** Names the machine `gh` runs on, in the not-signed-in notice. */
  environmentLabel?: string | null
  className?: string
}

/**
 * The session's pull requests: a list, and one of them in full.
 *
 * With several, the panel opens on the list, grouped by state the way Linear
 * groups issues, and a row opens that pull request on its own page; Esc or the
 * back button returns to the list, and J/K step to the next one without
 * leaving the page. With one, the page is all there is.
 */
export function PullRequestsPanel({
  pullRequests,
  openKey,
  onOpen,
  detail,
  detailLoading = false,
  detailError = null,
  onOpenOnGitHub,
  environmentLabel,
  className,
}: PullRequestsPanelProps) {
  const reduceMotion = useReducedMotion()
  const several = pullRequests.length > 1
  const ordered = orderForList(pullRequests)
  const opened = several
    ? (pullRequests.find((pr) => pullRequestKey(pr) === openKey) ?? null)
    : (pullRequests[0] ?? null)
  const openedKey = opened ? pullRequestKey(opened) : null
  const openedIndex = opened ? ordered.findIndex((pr) => pullRequestKey(pr) === openedKey) : -1

  // The list remembers the row you came back from.
  const [highlight, setHighlight] = useState<string | null>(openedKey)
  useEffect(() => {
    if (openedKey) setHighlight(openedKey)
  }, [openedKey])
  const highlightIndex = Math.max(
    0,
    ordered.findIndex((pr) => pullRequestKey(pr) === highlight),
  )

  const step = (by: number) => {
    const next = ordered[openedIndex + by]
    if (next) onOpen(pullRequestKey(next))
  }

  usePanelKeys((event) => {
    const key = event.key.toLowerCase()
    if (opened) {
      if (key === 'o') {
        onOpenOnGitHub(opened.url)
        return true
      }
      if (!several) return false
      if (event.key === 'Escape' || event.key === 'Backspace') {
        onOpen(null)
        return true
      }
      if (key === 'j' || event.key === 'ArrowDown') {
        step(1)
        return true
      }
      if (key === 'k' || event.key === 'ArrowUp') {
        step(-1)
        return true
      }
      return false
    }
    const lit = ordered[highlightIndex]
    if (key === 'j' || event.key === 'ArrowDown') {
      const next = ordered[Math.min(ordered.length - 1, highlightIndex + 1)]
      if (next) setHighlight(pullRequestKey(next))
      return true
    }
    if (key === 'k' || event.key === 'ArrowUp') {
      const next = ordered[Math.max(0, highlightIndex - 1)]
      if (next) setHighlight(pullRequestKey(next))
      return true
    }
    if ((event.key === 'Enter' || event.key === 'ArrowRight' || key === 'l') && lit) {
      onOpen(pullRequestKey(lit))
      return true
    }
    if (key === 'o' && lit) {
      onOpenOnGitHub(lit.url)
      return true
    }
    return false
  })

  // A new page starts at the top.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [openedKey])

  const detailFor = detail && opened && pullRequestKey(detail) === openedKey ? detail : null
  const offset = reduceMotion ? 0 : 12

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col text-[var(--basis-text)]', className)}>
      {pullRequests.length === 0 ? (
        <p className="px-4 pt-12 text-center text-12-regular text-[var(--basis-text-faint)]">
          No pull requests linked to this session yet.
          <br />
          Agents link the ones they open.
        </p>
      ) : (
        <AnimatePresence initial={false} mode="popLayout">
          {opened ? (
            <motion.div
              key="detail"
              initial={{ opacity: 0, x: offset }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: offset, transition: spring.moderate.exit }}
              transition={reduceMotion ? { duration: 0 } : spring.moderate}
              className="flex min-h-0 flex-1 flex-col"
            >
              {!several ? <PanelSubheader title="Pull request" /> : null}
              {several ? (
                <DetailBar
                  index={openedIndex}
                  total={ordered.length}
                  onBack={() => onOpen(null)}
                  onStep={step}
                />
              ) : null}
              <div
                ref={scrollRef}
                className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-6"
              >
                <AnimatePresence initial={false} mode="wait">
                  <motion.div
                    key={openedKey}
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.06 } }}
                    transition={reduceMotion ? { duration: 0 } : spring.moderate}
                  >
                    <PullRequestDetailView
                      summary={opened}
                      detail={detailFor}
                      loading={detailLoading}
                      error={detailError}
                      onOpenOnGitHub={onOpenOnGitHub}
                      environmentLabel={environmentLabel}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="list"
              initial={{ opacity: 0, x: -offset }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -offset, transition: spring.moderate.exit }}
              transition={reduceMotion ? { duration: 0 } : spring.moderate}
              className="flex min-h-0 flex-1 flex-col"
            >
              <PanelSubheader
                title="Pull requests"
                meta={<span className="tabular-nums">{pullRequests.length}</span>}
              />
              <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
                <PullRequestList
                  pullRequests={ordered}
                  highlight={pullRequestKey(ordered[highlightIndex]!)}
                  onHighlight={setHighlight}
                  onOpen={onOpen}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

// ─── The list ───────────────────────────────────────────────────────────────

type Group = { id: 'active' | 'done'; label: string; states: (PullRequestState | null)[] }

/**
 * Two groups, Linear's way: what is still moving (open, draft, not read yet)
 * and what is done (merged, closed). The row's own glyph tells the states
 * within a group apart.
 */
const GROUPS: Group[] = [
  { id: 'active', label: 'Open', states: ['open', 'draft', null] },
  { id: 'done', label: 'Done', states: ['merged', 'closed'] },
]

/** Group order, then the state order within it, newest link first. */
function orderForList(pullRequests: readonly PullRequestSummary[]): PullRequestSummary[] {
  const newestFirst = [...pullRequests].reverse()
  return GROUPS.flatMap((group) =>
    group.states.flatMap((state) => newestFirst.filter((pr) => pr.state === state)),
  )
}

function PullRequestList({
  pullRequests,
  highlight,
  onHighlight,
  onOpen,
}: {
  pullRequests: readonly PullRequestSummary[]
  highlight: string
  onHighlight: (key: string) => void
  onOpen: (key: string) => void
}) {
  const now = useNow()
  const groups = GROUPS.map((group) => ({
    group,
    items: pullRequests.filter((pr) => group.states.includes(pr.state)),
  })).filter((entry) => entry.items.length > 0)
  // One group needs no heading: the subheader already says what this is.
  const headed = groups.length > 1

  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ group, items }) => (
        <section key={group.id} aria-label={group.label}>
          {headed ? (
            <h3 className="flex h-7 items-center gap-1.5 px-2 text-11-medium text-[var(--basis-text-muted)]">
              {group.label}
              <span className="tabular-nums opacity-70">{items.length}</span>
            </h3>
          ) : null}
          <ul className="flex flex-col gap-px">
            {items.map((pr) => {
              const key = pullRequestKey(pr)
              return (
                <PullRequestRow
                  key={key}
                  pr={pr}
                  now={now}
                  highlighted={key === highlight}
                  onHighlight={() => onHighlight(key)}
                  onOpen={() => onOpen(key)}
                />
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * One pull request: its state, the title on up to two lines, then a line of
 * what decides whether you need to look — checks that are not green, the
 * review, the size — and how long ago it last moved.
 */
function PullRequestRow({
  pr,
  now,
  highlighted,
  onHighlight,
  onOpen,
}: {
  pr: PullRequestSummary
  now: number
  highlighted: boolean
  onHighlight: () => void
  onOpen: () => void
}) {
  const meta = stateMeta(pr.state)
  const checks = pr.checks ? PR_CHECKS[pr.checks] : null
  const review = pr.reviewDecision ? REVIEW_DECISION[pr.reviewDecision] : null
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  const updated = ago(pr.updatedAt ?? pr.linkedAt, now)

  return (
    <li>
      <button
        ref={ref}
        type="button"
        onClick={onOpen}
        onMouseEnter={onHighlight}
        onFocus={onHighlight}
        data-highlighted={highlighted || undefined}
        className={cn(
          'flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-[7px] text-left',
          'transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-ring',
          highlighted && 'bg-hover',
        )}
      >
        <meta.Icon
          size={14}
          weight="bold"
          className="mt-[2px] shrink-0"
          style={{ color: meta.color }}
          aria-label={meta.label}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]" title={pr.title ?? undefined}>
          <span
            className={`text-13-regular ${cn(
              'truncate leading-[1.35] text-[var(--basis-text-strong)]',
              pr.title === null && 'text-[var(--basis-text-muted)]',
            )}`}
          >
            {pr.title ?? `${pr.repository} #${pr.number}`}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11-regular leading-none text-[var(--basis-text-muted)]">
            <span className="tabular-nums">#{pr.number}</span>
            {checks && pr.checks !== 'passing' ? (
              <span className="flex items-center gap-1" style={{ color: checks.color }}>
                <checks.Icon size={11} weight="bold" aria-hidden />
                {checks.label}
              </span>
            ) : null}
            {review && pr.reviewDecision !== 'review_required' ? (
              <span className="flex items-center gap-1" style={{ color: review.color }}>
                <review.Icon size={11} weight="bold" aria-hidden />
                {review.label}
              </span>
            ) : null}
            <Diffstat
              additions={pr.additions}
              deletions={pr.deletions}
              className="text-11-regular"
            />
            {pr.problem ? (
              <span className="flex items-center gap-1 text-[var(--basis-status-needs)]">
                <span className="size-1.5 rounded-full bg-current" aria-hidden />
                Not read
              </span>
            ) : null}
          </span>
        </span>
        {updated ? (
          <span className="mt-[3px] shrink-0 text-11-regular leading-none text-[var(--basis-text-faint)]">
            {updated}
          </span>
        ) : null}
      </button>
    </li>
  )
}

// ─── The page's bar ─────────────────────────────────────────────────────────

/** Back to the list, where this one sits in it, and the next and previous. */
function DetailBar({
  index,
  total,
  onBack,
  onStep,
}: {
  index: number
  total: number
  onBack: () => void
  onStep: (by: number) => void
}) {
  const iconButton =
    'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--basis-text-muted)] transition-colors duration-150 hover:bg-hover hover:text-[var(--basis-text-strong)] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent'
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2">
      <Tooltip
        side="bottom"
        content={
          <span className="flex items-center gap-1.5">
            All pull requests <Kbd inverted>Esc</Kbd>
          </span>
        }
      >
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-md pr-2 pl-1 text-12-medium text-[var(--basis-text-muted)] transition-colors duration-150 hover:bg-hover hover:text-[var(--basis-text-strong)] focus-visible:outline-2 focus-visible:outline-ring"
        >
          <CaretLeftIcon size={14} aria-hidden />
          All pull requests
        </button>
      </Tooltip>
      <span className="flex-1" />
      <span className="px-1 text-11-regular text-[var(--basis-text-faint)] tabular-nums">
        {index + 1} / {total}
      </span>
      <Tooltip
        side="bottom"
        content={
          <span className="flex items-center gap-1.5">
            Previous <Kbd inverted>K</Kbd>
          </span>
        }
      >
        <button
          type="button"
          aria-label="Previous pull request"
          disabled={index <= 0}
          onClick={() => onStep(-1)}
          className={iconButton}
        >
          <CaretUpIcon size={14} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip
        side="bottom"
        content={
          <span className="flex items-center gap-1.5">
            Next <Kbd inverted>J</Kbd>
          </span>
        }
      >
        <button
          type="button"
          aria-label="Next pull request"
          disabled={index >= total - 1}
          onClick={() => onStep(1)}
          className={iconButton}
        >
          <CaretDownIcon size={14} aria-hidden />
        </button>
      </Tooltip>
    </div>
  )
}

/** The home row's summary for the pull requests view, in the list's own terms. */
export function pullRequestsSummary(pullRequests: readonly PullRequestSummary[]): string {
  if (pullRequests.length === 0) return 'None linked yet'
  const count = (state: PullRequestState | null) =>
    pullRequests.filter((pr) => pr.state === state).length
  const parts = (
    [
      ['open', count('open')],
      ['draft', count('draft')],
      ['merged', count('merged')],
      ['closed', count('closed')],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`)
  return parts.join(' · ') || `${pullRequests.length} linked`
}
