import { type ReactNode } from 'react'
import { activityRow, activityDetailsSummary } from './ToolLine'

interface CollapsibleStepsProps {
  stepsCount: number
  children: ReactNode
  defaultExpanded?: boolean
}

export function CollapsibleSteps({
  stepsCount,
  children,
  defaultExpanded = false,
}: CollapsibleStepsProps) {
  if (stepsCount === 0) return null

  return (
    <details className={`group ${activityRow}`} open={defaultExpanded}>
      <summary className={activityDetailsSummary}>
        <span className="text-[var(--basis-text-muted)]">Worked</span>{' '}
        <span className="text-[var(--basis-text-faint)]">
          {stepsCount} step{stepsCount !== 1 ? 's' : ''}
        </span>
      </summary>
      <div className="mt-0.5 flex flex-col gap-0">{children}</div>
    </details>
  )
}
