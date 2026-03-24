import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

interface CollapsibleStepsProps {
  stepsCount: number
  children: ReactNode
  defaultExpanded?: boolean
}

export function CollapsibleSteps({ stepsCount, children, defaultExpanded = false }: CollapsibleStepsProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (stepsCount === 0) return null

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-0.5 px-2 cursor-pointer text-muted-foreground hover:text-foreground/70 transition-colors bg-transparent border-none text-left w-full"
      >
        <ChevronRight
          className={cn(
            'size-3.5 flex-shrink-0 transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        />
        <span className="text-[12px]">
          {stepsCount} step{stepsCount !== 1 ? 's' : ''}
        </span>
      </button>

      {expanded && (
        <div className="ml-2">
          {children}
        </div>
      )}
    </div>
  )
}
