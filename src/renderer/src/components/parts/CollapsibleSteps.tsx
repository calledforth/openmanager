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
        className="py-0.5 px-0 cursor-pointer text-muted-foreground hover:text-foreground/70 transition-colors bg-transparent border-none text-left w-full text-[14px]"
      >
        Worked, {stepsCount} step{stepsCount !== 1 ? 's' : ''}
      </button>

      {expanded && <div className="ml-0 mt-1 flex flex-col gap-1">{children}</div>}
    </div>
  )
}
