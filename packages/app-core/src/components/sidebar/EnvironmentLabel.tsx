import { HardDrivesIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/Tooltip'

/**
 * Names the environment projects and sessions run on. Deliberately faint:
 * with one environment it is context, not news, but the copy is always there
 * so a second environment only has to add another label.
 */
export function EnvironmentLabel({ label, className }: { label: string; className?: string }) {
  return (
    <Tooltip content={`Sessions run on ${label}`} side="bottom">
      <span
        className={cn(
          'inline-flex min-w-0 items-center gap-1 text-[var(--basis-text-faint)]',
          className,
        )}
      >
        <HardDrivesIcon weight="light" aria-hidden className="h-3 w-3 shrink-0" />
        <span className="sr-only">Environment: </span>
        <span className="truncate">{label}</span>
      </span>
    </Tooltip>
  )
}
