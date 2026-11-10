import { AppleLogoIcon, LinuxLogoIcon, WindowsLogoIcon, type Icon } from '@phosphor-icons/react'
import {
  environmentPlatformName,
  type EnvironmentDistro,
  type EnvironmentPlatform,
} from '@openmanager/protocol'
import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siArtixlinux,
  siAsahilinux,
  siCachyos,
  siCentos,
  siDebian,
  siDeepin,
  siElementary,
  siEndeavouros,
  siFedora,
  siGarudalinux,
  siGentoo,
  siKalilinux,
  siKdeneon,
  siKubuntu,
  siLinuxmint,
  siLubuntu,
  siManjaro,
  siMxlinux,
  siNixos,
  siNobaralinux,
  siOpensuse,
  siParrotsecurity,
  siPopos,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siSlackware,
  siSolus,
  siUbuntu,
  siVoidlinux,
  siXubuntu,
  siZorin,
  type SimpleIcon,
} from 'simple-icons'
import { cn } from '../../lib/utils'

/** WSL is Linux to whatever runs in it; its name, not its glyph, tells it from Windows. */
const GLYPHS: Record<EnvironmentPlatform, Icon> = {
  windows: WindowsLogoIcon,
  wsl: LinuxLogoIcon,
  linux: LinuxLogoIcon,
  macos: AppleLogoIcon,
}

/**
 * Distro logos by os-release `ID` (os-release(5)). A derivative not listed
 * finds its parent through `ID_LIKE`, and anything else keeps Tux.
 */
const DISTRO_LOGOS: Readonly<Record<string, SimpleIcon>> = {
  almalinux: siAlmalinux,
  alpine: siAlpinelinux,
  arch: siArchlinux,
  artix: siArtixlinux,
  'fedora-asahi-remix': siAsahilinux,
  cachyos: siCachyos,
  centos: siCentos,
  debian: siDebian,
  deepin: siDeepin,
  elementary: siElementary,
  endeavouros: siEndeavouros,
  fedora: siFedora,
  garuda: siGarudalinux,
  gentoo: siGentoo,
  kali: siKalilinux,
  neon: siKdeneon,
  kubuntu: siKubuntu,
  linuxmint: siLinuxmint,
  lubuntu: siLubuntu,
  manjaro: siManjaro,
  'manjaro-arm': siManjaro,
  mx: siMxlinux,
  nixos: siNixos,
  nobara: siNobaralinux,
  opensuse: siOpensuse,
  'opensuse-leap': siOpensuse,
  'opensuse-tumbleweed': siOpensuse,
  'opensuse-microos': siOpensuse,
  parrot: siParrotsecurity,
  pop: siPopos,
  raspbian: siRaspberrypi,
  rhel: siRedhat,
  rocky: siRockylinux,
  slackware: siSlackware,
  solus: siSolus,
  ubuntu: siUbuntu,
  void: siVoidlinux,
  xubuntu: siXubuntu,
  zorin: siZorin,
}

function distroLogo(distro: EnvironmentDistro): SimpleIcon | undefined {
  for (const id of [distro.id, ...(distro.like ?? [])]) {
    if (Object.hasOwn(DISTRO_LOGOS, id)) return DISTRO_LOGOS[id]
  }
  return undefined
}

/** Only Linux and WSL have one. */
function distroOf(
  platform: EnvironmentPlatform | undefined,
  distro: EnvironmentDistro | undefined,
) {
  return platform === 'linux' || platform === 'wsl' ? distro : undefined
}

/**
 * What an environment runs, as read: "Windows", "Ubuntu", "Ubuntu (WSL)", or
 * "WSL" when its server names no distro. Undefined for an unknown platform.
 */
export function environmentOsName(
  platform: EnvironmentPlatform | undefined,
  distro?: EnvironmentDistro,
): string | undefined {
  const platformName = environmentPlatformName(platform)
  if (!platformName) return undefined
  const known = distroOf(platform, distro)
  if (!known) return platformName
  const name = known.name ?? distroLogo(known)?.title ?? known.id
  return platform === 'wsl' ? `${name} (WSL)` : name
}

/**
 * The logo of what an environment runs, shown after its name: its distro's
 * on Linux and WSL when it has one, else Windows, Apple or Tux. Hovering
 * names it ("Ubuntu (WSL)"); a reader that already says it beside the name
 * passes `aria-hidden` so it is not said twice.
 */
export function EnvironmentPlatformIcon({
  platform,
  distro,
  className,
  'aria-hidden': ariaHidden,
}: {
  platform: EnvironmentPlatform | undefined
  distro?: EnvironmentDistro
  className?: string
  'aria-hidden'?: boolean
}) {
  const name = environmentOsName(platform, distro)
  if (!platform || !name) return null
  const a11y = ariaHidden
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': name } as const)
  const classes = cn('h-3 w-3 shrink-0', className)
  const known = distroOf(platform, distro)
  const logo = known && distroLogo(known)
  if (logo) {
    return (
      // Simple Icons fill their 24px box edge to edge; the margin sizes them
      // like the Phosphor logos beside them.
      <svg
        viewBox="-3 -3 30 30"
        fill="currentColor"
        {...a11y}
        data-platform={platform}
        data-distro={known.id}
        className={classes}
      >
        <title>{name}</title>
        <path d={logo.path} />
      </svg>
    )
  }
  const Glyph = GLYPHS[platform]
  return <Glyph weight="fill" alt={name} {...a11y} data-platform={platform} className={classes} />
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
