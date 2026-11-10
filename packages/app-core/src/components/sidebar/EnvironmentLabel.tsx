import { HardDrivesIcon } from '@phosphor-icons/react'
import { environmentPlatformName, type EnvironmentPlatform } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { EnvironmentPlatformIcon } from '../ui/EnvironmentPlatformIcon'
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
   * The kind of machine. Its logo follows the name, so a Windows machine and
   * a WSL distro on it, which share a host name, read apart.
   */
  platform?: EnvironmentPlatform
  className?: string
}) {
  const platformName = environmentPlatformName(platform)
  const named = platformName ? `${label} (${platformName})` : label
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
        {platformName ? <span className="sr-only"> ({platformName})</span> : null}
        <EnvironmentPlatformIcon platform={platform} aria-hidden />
      </span>
    </Tooltip>
  )
}
