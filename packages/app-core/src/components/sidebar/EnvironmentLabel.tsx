import { HardDrivesIcon } from '@phosphor-icons/react'
import type { EnvironmentDistro, EnvironmentPlatform } from '@openmanager/protocol'
import { cn } from '../../lib/utils'
import { EnvironmentPlatformIcon, environmentOsName } from '../ui/EnvironmentPlatformIcon'
import { Tooltip } from '../ui/Tooltip'

/**
 * Names the environment projects and sessions run on. Deliberately faint:
 * with one environment it is context, not news, but the copy is always there
 * so a second environment only has to add another label.
 */
export function EnvironmentLabel({
  label,
  platform,
  distro,
  className,
}: {
  label: string
  /**
   * The kind of machine. Its logo follows the name, so a Windows machine and
   * a WSL distro on it, which share a host name, read apart.
   */
  platform?: EnvironmentPlatform
  /** Its Linux distribution, whose logo then stands in for Tux. */
  distro?: EnvironmentDistro
  className?: string
}) {
  const osName = environmentOsName(platform, distro)
  const named = osName ? `${label} (${osName})` : label
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
        <EnvironmentPlatformIcon
          platform={platform}
          distro={distro}
          aria-hidden
          fallback={<HardDrivesIcon weight="light" aria-hidden className="h-3 w-3 shrink-0" />}
        />
        <span className="sr-only">Sessions run on </span>
        <span className="truncate">{label}</span>
        {osName ? <span className="sr-only"> ({osName})</span> : null}
      </span>
    </Tooltip>
  )
}
