import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ActivitySummary } from '@openmanager/shared/lib/activity-groups'
import { activityRow, activityDetailsSummary, shimmerTextClass, shimmerTextStyle } from './ToolLine'

/**
 * One branch of a work group's tree: an L-shaped line from the group's
 * header (or the row above) into the row it holds, the way a file tree
 * hangs a file under its folder.
 */
export function TreeBranch({ children }: { children: ReactNode }) {
  return (
    <div className="relative pl-[18px]" data-tree-branch>
      <span
        aria-hidden
        className="pointer-events-none absolute left-[5px] top-0 h-[0.8em] w-[8px] rounded-bl-[4px] border-b border-l border-[var(--basis-border)]"
      />
      {children}
    </div>
  )
}

/**
 * Collapsed summary for a run of the agent's work: its tool calls, and the
 * thoughts between them. "Edited 4 files, explored 2 files, ran 3 commands".
 * Stays collapsed by default, including while the run is live: the header
 * rewrites itself as calls land so the turn reads as one updating line, and
 * opening it reveals the calls and thoughts in the order they happened.
 *
 * A thought the agent is having right now hangs under the header on its own
 * branch (`live`), its words streaming beneath it, and only it shimmers. Once
 * it ends it folds into the group with nothing left to show for it but its
 * place among the calls.
 */
export function ActivityGroup({
  summary,
  live,
  children,
}: {
  summary: ActivitySummary
  /** The thought streaming now, drawn under the header while it is closed. */
  live?: ReactNode
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Follow the tail when a member lands, not on every token of a thought:
  // a reader who scrolled up inside the open group stays where they are.
  const thinking = !!live
  useEffect(() => {
    if ((summary.isRunning || thinking) && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [summary.isRunning, summary.toolCount, summary.thoughtCount, thinking, expanded])

  const hasDiffStat = summary.diffAdded > 0 || summary.diffRemoved > 0

  return (
    <div className={activityRow} data-activity-group>
      <details
        className="group"
        open={expanded}
        onToggle={(event) => {
          // React passes a member's own toggle (a thought opening as it
          // streams, a call's output opened) up to here: only the group's
          // own opens or closes it.
          if (event.target !== event.currentTarget) return
          setExpanded(event.currentTarget.open)
        }}
      >
        <summary className={activityDetailsSummary}>
          {summary.isRunning ? (
            <span className={shimmerTextClass} style={shimmerTextStyle}>
              {summary.runningText}
            </span>
          ) : (
            <span className="min-w-0">
              <span className="text-[var(--basis-text-muted)]">{summary.text}</span>
              {hasDiffStat && (
                <>
                  {' '}
                  <span className="text-emerald-500/80 tabular-nums">
                    +{summary.diffAdded}
                  </span>{' '}
                  <span className="text-rose-500/80 tabular-nums">-{summary.diffRemoved}</span>
                </>
              )}
            </span>
          )}
        </summary>
        <div
          ref={bodyRef}
          className="thin-scrollbar ml-[5px] mt-0.5 max-h-[260px] overflow-y-auto border-l border-[var(--basis-border)] pl-3"
          data-activity-group-body
        >
          {children}
        </div>
      </details>
      {!expanded && live ? <TreeBranch>{live}</TreeBranch> : null}
    </div>
  )
}
