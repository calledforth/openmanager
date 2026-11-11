import { GitPullRequestIcon } from '@phosphor-icons/react'
import type { PullRequestSummary } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { Tooltip } from '../fluid/ui/tooltip'
import { stateMeta } from './pull-request-status'

/** The most state dots the pill shows; past that the count carries it. */
const DOTS_MAX = 6

/**
 * The session's pull requests, at the right end of the chat topbar. One pull
 * request shows as its number in its state's colour; several show as a count
 * with a dot per pull request, so the mix of open, merged and failed reads
 * from across the room. Click toggles the panel; `]` does the same, and the
 * tooltip says so the way the sidebar's trigger does.
 *
 * The host hides it when the session links nothing; it never renders empty.
 */
export function PullRequestPill({
  pullRequests,
  open,
  onToggle,
  shortcut = ']',
  className,
}: {
  pullRequests: readonly PullRequestSummary[]
  /** Whether the panel it toggles is showing. */
  open: boolean
  onToggle: () => void
  /** The bare key that also toggles the panel; null hides the hint. */
  shortcut?: string | null
  className?: string
}) {
  if (pullRequests.length === 0) return null
  const only = pullRequests.length === 1 ? pullRequests[0]! : null
  const meta = stateMeta(only?.state ?? null)
  const failing = pullRequests.filter((pr) => pr.checks === 'failing').length
  const label = only
    ? `Pull request #${only.number}${only.state ? `, ${meta.label.toLowerCase()}` : ''}`
    : `${pullRequests.length} pull requests`

  return (
    <Tooltip
      side="bottom"
      content={
        <span className="flex items-center gap-1.5">
          <span>{open ? 'Hide pull requests' : 'Show pull requests'}</span>
          {shortcut ? (
            <kbd className="-my-1 flex h-4 min-w-4 items-center justify-center rounded border border-background/30 px-1 font-sans text-[10px] text-background/80">
              {shortcut}
            </kbd>
          ) : null}
        </span>
      }
    >
      <button
        type="button"
        aria-pressed={open}
        aria-label={`${label}. ${failing ? `${failing} with failing checks. ` : ''}${open ? 'Hide' : 'Show'} the panel`}
        onClick={onToggle}
        className={cn(
          'group/pr flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full pl-2 pr-2.5',
          'transition-[background-color,box-shadow,color] duration-150 ease-out',
          'focus-visible:outline-2 focus-visible:outline-ring',
          open
            ? 'bg-active text-[var(--basis-text-strong)]'
            : 'bg-float text-[var(--basis-text)] shadow-float-rest hover:text-[var(--basis-text-strong)]',
          className,
        )}
      >
        {only ? (
          <>
            <meta.Icon
              size={13}
              weight="bold"
              className="shrink-0"
              style={{ color: meta.color }}
              aria-hidden
            />
            <span className="text-11-medium leading-none tabular-nums">#{only.number}</span>
          </>
        ) : (
          <>
            <GitPullRequestIcon
              size={13}
              weight="bold"
              className="shrink-0 text-[var(--basis-text-muted)] transition-colors group-hover/pr:text-[var(--basis-text)]"
              aria-hidden
            />
            <span className="text-11-medium leading-none tabular-nums">{pullRequests.length}</span>
            <span className="flex items-center gap-[3px]" aria-hidden>
              {pullRequests.slice(0, DOTS_MAX).map((pr) => {
                const m = stateMeta(pr.state)
                return (
                  <span
                    key={`${pr.repository}#${pr.number}`}
                    className="size-[5px] rounded-full"
                    style={{ backgroundColor: m.color }}
                  />
                )
              })}
            </span>
          </>
        )}
        {failing > 0 ? (
          <span
            className="-ml-0.5 size-1.5 rounded-full"
            style={{ backgroundColor: 'var(--basis-status-error)' }}
            aria-hidden
          />
        ) : null}
      </button>
    </Tooltip>
  )
}
