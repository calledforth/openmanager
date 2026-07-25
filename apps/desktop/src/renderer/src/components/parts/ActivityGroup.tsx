import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ActivitySummary } from '@openmanager/shared/lib/activity-groups'
import { activityRow, activityDetailsSummary, shimmerTextClass, shimmerTextStyle } from './ToolLine'

/**
 * Collapsed summary for a run of consecutive tool calls — "Edited 4 files,
 * explored 2 files, ran 3 commands". Stays collapsed by default, including
 * while the run is live: the header rewrites itself as calls land so the turn
 * reads as one updating line, and opening it reveals the individual calls.
 */
export function ActivityGroup({
  summary,
  children,
}: {
  summary: ActivitySummary
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (summary.isRunning && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [summary.isRunning, summary.toolCount, expanded])

  const hasDiffStat = summary.diffAdded > 0 || summary.diffRemoved > 0

  return (
    <details
      className={`group ${activityRow}`}
      open={expanded}
      onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}
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
                <span className="text-emerald-500/80 tabular-nums">+{summary.diffAdded}</span>{' '}
                <span className="text-rose-500/80 tabular-nums">-{summary.diffRemoved}</span>
              </>
            )}
          </span>
        )}
      </summary>
      <div
        ref={bodyRef}
        className="thin-scrollbar mt-0.5 max-h-[260px] overflow-y-auto border-l border-[var(--basis-border-muted)] pl-2"
      >
        {children}
      </div>
    </details>
  )
}
