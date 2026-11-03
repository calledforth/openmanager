import { HardDrivesIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/Tooltip'

/**
 * Names the environment projects and sessions run on. Deliberately faint:
 * with one environment it is context, not news, but the copy is always there
 * so a second environment only has to add another label.
 */
export function EnvironmentLabel({
  label,
  platform,
  className,
}: {
  label: string
  /**
   * The kind of machine, as read ("WSL"). Shown after the name, so a Windows
   * machine and a WSL distro on it, which share a host name, read apart.
   */
  platform?: string
  className?: string
}) {
  const named = platform ? `${label} (${platform})` : label
  // The label is not a tab stop, so the tooltip is only a pointer nicety: the
  // visually hidden prefix carries the same explanation for assistive tech.
  return (
    <Tooltip content={`Sessions run on ${named}`} side="bottom">
      <span
        className={cn(
          'inline-flex min-w-0 items-center gap-1 text-[var(--basis-text-faint)]',
          className,
        )}
      >
        <HardDrivesIcon weight="light" aria-hidden className="h-3 w-3 shrink-0" />
        <span className="sr-only">Sessions run on </span>
        <span className="truncate">{label}</span>
        {platform ? (
          <span className="shrink-0 rounded bg-[var(--basis-surface-hover)] px-1 text-[0.9em] leading-tight">
            <span className="sr-only"> (</span>
            {platform}
            <span className="sr-only">)</span>
          </span>
        ) : null}
      </span>
    </Tooltip>
  )
}
