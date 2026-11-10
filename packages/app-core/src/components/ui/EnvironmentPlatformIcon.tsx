import { AppleLogoIcon, LinuxLogoIcon, WindowsLogoIcon, type Icon } from '@phosphor-icons/react'
import { environmentPlatformName, type EnvironmentPlatform } from '@openmanager/protocol'
import { cn } from '../../lib/utils'

/** WSL is Linux to whatever runs in it; its name, not its glyph, tells it from Windows. */
const GLYPHS: Record<EnvironmentPlatform, Icon> = {
  windows: WindowsLogoIcon,
  wsl: LinuxLogoIcon,
  linux: LinuxLogoIcon,
  macos: AppleLogoIcon,
}

/**
 * The logo of the kind of machine an environment runs on, shown after its
 * name. Hovering names the platform ("WSL"); a reader that already says it
 * beside the name passes `aria-hidden` so it is not said twice.
 */
export function EnvironmentPlatformIcon({
  platform,
  className,
  'aria-hidden': ariaHidden,
}: {
  platform: EnvironmentPlatform | undefined
  className?: string
  'aria-hidden'?: boolean
}) {
  const name = environmentPlatformName(platform)
  if (!platform || !name) return null
  const Glyph = GLYPHS[platform]
  return (
    <Glyph
      weight="fill"
      alt={name}
      {...(ariaHidden ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      data-platform={platform}
      className={cn('h-3 w-3 shrink-0', className)}
    />
  )
}

/**
 * A name from a list that adds the platform to tell twins apart ("Laptop
 * (WSL)"), without it: for a place that shows the platform's logo instead.
 */
export function nameWithoutPlatform(label: string, platform: EnvironmentPlatform | undefined) {
  const name = environmentPlatformName(platform)
  const suffix = name ? ` (${name})` : undefined
  return suffix && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label
}
