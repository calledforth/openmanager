import { useState, type ReactNode } from 'react'

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
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (stepsCount === 0) return null

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full cursor-pointer border-none bg-transparent py-0.5 px-0 text-left text-xs font-semibold text-foreground/90 transition-colors hover:text-foreground"
      >
        Worked, {stepsCount} step{stepsCount !== 1 ? 's' : ''}
      </button>

      {expanded && <div className="ml-0 mt-1 flex flex-col gap-1">{children}</div>}
    </div>
  )
}
