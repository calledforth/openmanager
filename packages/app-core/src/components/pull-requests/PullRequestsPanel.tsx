import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { PullRequestDetail, PullRequestSummary } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { spring } from '../fluid/lib/springs'
import { PullRequestDetailView } from './PullRequestDetailView'
import { PR_CHECKS, pullRequestKey, stateMeta } from './pull-request-status'

export interface PullRequestsPanelProps {
  pullRequests: readonly PullRequestSummary[]
  /** `pullRequestKey(summary)` of the one shown; null falls back to the first. */
  selectedKey: string | null
  onSelect: (key: string) => void
  /** The selected pull request in full, when the client has it. */
  detail: PullRequestDetail | null
  detailLoading?: boolean
  detailError?: string | null
  onOpenOnGitHub: (url: string) => void
  /** Names the machine `gh` runs on, in the not-signed-in notice. */
  environmentLabel?: string | null
  className?: string
}

/**
 * The right panel: the session's pull requests, one of them in full.
 *
 * With one pull request the panel is its page. With several, a compact list
 * sits above the page — each row a state glyph, the title, and what matters
 * at a glance (failing checks, size) — and the chosen row is a filled
 * selection, Linear's way of marking the record you are on. The list stays
 * put while you switch, so comparing four pull requests is four clicks, not
 * four round trips through a back button.
 */
export function PullRequestsPanel({
  pullRequests,
  selectedKey,
  onSelect,
  detail,
  detailLoading = false,
  detailError = null,
  onOpenOnGitHub,
  environmentLabel,
  className,
}: PullRequestsPanelProps) {
  const selected =
    pullRequests.find((pr) => pullRequestKey(pr) === selectedKey) ?? pullRequests[0] ?? null
  const several = pullRequests.length > 1
  const reduceMotion = useReducedMotion()

  // Switching pull requests starts the page at the top: the detail scrolls
  // in its own box, and the previous one's scroll position means nothing here.
  const scrollRef = useRef<HTMLDivElement>(null)
  const shownKey = selected ? pullRequestKey(selected) : null
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [shownKey])

  const detailFor =
    detail && selected && pullRequestKey(detail) === pullRequestKey(selected) ? detail : null

  return (
    <section
      aria-label="Pull requests"
      className={cn('flex h-full min-h-0 min-w-0 flex-col text-[var(--basis-text)]', className)}
    >
      <div className="flex h-9 shrink-0 items-center px-4">
        <h2 className="text-12-medium text-[var(--basis-text-muted)]">
          {several ? `${pullRequests.length} pull requests` : 'Pull request'}
        </h2>
      </div>

      {several ? (
        <ul
          role="listbox"
          aria-label="Linked pull requests"
          className="custom-scrollbar flex max-h-[40%] shrink-0 flex-col gap-px overflow-y-auto px-2 pb-2"
        >
          {pullRequests.map((pr) => {
            const key = pullRequestKey(pr)
            return (
              <PullRequestRow
                key={key}
                pr={pr}
                selected={key === shownKey}
                onSelect={() => onSelect(key)}
              />
            )
          })}
        </ul>
      ) : null}

      <div
        ref={scrollRef}
        className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-6"
      >
        <AnimatePresence initial={false} mode="wait">
          {selected ? (
            <motion.div
              key={shownKey}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : spring.moderate}
            >
              <PullRequestDetailView
                summary={selected}
                detail={detailFor}
                loading={detailLoading}
                error={detailError}
                onOpenOnGitHub={onOpenOnGitHub}
                environmentLabel={environmentLabel}
              />
            </motion.div>
          ) : (
            <p
              key="empty"
              className="pt-8 text-center text-12-regular text-[var(--basis-text-faint)]"
            >
              No pull requests linked to this session.
            </p>
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}

/** One row of the switcher: state, title, and the size and checks at the end. */
function PullRequestRow({
  pr,
  selected,
  onSelect,
}: {
  pr: PullRequestSummary
  selected: boolean
  onSelect: () => void
}) {
  const meta = stateMeta(pr.state)
  const checks = pr.checks ? PR_CHECKS[pr.checks] : null
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left',
          'transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-ring',
          selected ? 'bg-active' : 'hover:bg-hover',
        )}
      >
        <meta.Icon
          size={14}
          weight="bold"
          className="shrink-0"
          style={{ color: meta.color }}
          aria-label={meta.label}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-12-regular',
            selected ? 'text-[var(--basis-text-strong)]' : 'text-[var(--basis-text)]',
            pr.title === null && 'text-[var(--basis-text-muted)]',
          )}
        >
          {pr.title ?? `${pr.repository} #${pr.number}`}
        </span>
        {pr.problem ? (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: 'var(--basis-status-needs)' }}
            aria-label="Could not be read"
          />
        ) : null}
        {checks && pr.checks !== 'passing' ? (
          <checks.Icon
            size={12}
            weight="bold"
            className="shrink-0"
            style={{ color: checks.color }}
            aria-label={`Checks ${checks.label.toLowerCase()}`}
          />
        ) : null}
        <span className="shrink-0 text-11-regular leading-none text-[var(--basis-text-faint)] tabular-nums">
          #{pr.number}
        </span>
      </button>
    </li>
  )
}
