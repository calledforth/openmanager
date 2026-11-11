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
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { useLightScheme } from '../../providers/theme-provider'

/**
 * WSL is Linux to whatever runs in it; its name, not its glyph, tells it from
 * Windows. Windows takes one blue rather than its four-colour flag, and Apple
 * has no colour of its own, so it takes the text's.
 */
const GLYPHS: Record<EnvironmentPlatform, { glyph: Icon; hex?: string }> = {
  windows: { glyph: WindowsLogoIcon, hex: '0078D4' },
  wsl: { glyph: LinuxLogoIcon, hex: 'FCC624' },
  linux: { glyph: LinuxLogoIcon, hex: 'FCC624' },
  macos: { glyph: AppleLogoIcon },
}

type Rgb = readonly [number, number, number]

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((value) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as unknown as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const readableCache = new Map<string, string>()

/**
 * A brand colour that still reads on this scheme's background: one too dark
 * for dark mode (Slackware's black) is lifted toward white, one too light for
 * light mode (Tux's yellow) taken toward black, only as far as it needs.
 */
function readableBrand(hex: string, light: boolean): string {
  const key = `${hex}:${light ? 'l' : 'd'}`
  const cached = readableCache.get(key)
  if (cached) return cached
  const brand = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb
  const background: Rgb = light ? [255, 255, 255] : [28, 28, 28]
  const toward = light ? 0 : 255
  let shade = brand
  for (let step = 1; step <= 10 && contrast(shade, background) < 3; step += 1) {
    shade = brand.map((value) =>
      Math.round(value + (toward - value) * (step / 10)),
    ) as unknown as Rgb
  }
  const color = `rgb(${shade.join(' ')})`
  readableCache.set(key, color)
  return color
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
 * The logo of what an environment runs, shown before its name: its distro's
 * on Linux and WSL when it has one, else Windows, Apple or Tux. In its brand
 * colour while the environment can be reached, and in the text's own grey
 * when `muted`. Hovering names it ("Ubuntu (WSL)"); a reader that already
 * says it beside the name passes `aria-hidden` so it is not said twice.
 * `fallback` stands in for a platform it has no logo for.
 */
export function EnvironmentPlatformIcon({
  platform,
  distro,
  muted = false,
  fallback = null,
  className,
  'aria-hidden': ariaHidden,
}: {
  platform: EnvironmentPlatform | undefined
  distro?: EnvironmentDistro
  /** The environment is out of reach: grey, like the rest of its row. */
  muted?: boolean
  fallback?: ReactNode
  className?: string
  'aria-hidden'?: boolean
}) {
  const light = useLightScheme()
  const name = environmentOsName(platform, distro)
  if (!platform || !name) return fallback
  const a11y = ariaHidden
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': name } as const)
  const known = distroOf(platform, distro)
  const logo = known && distroLogo(known)
  const { glyph: Glyph, hex: platformHex } = GLYPHS[platform]
  const hex = logo ? logo.hex : platformHex
  const classes = cn(
    'h-3 w-3 shrink-0',
    muted ? 'text-muted-foreground' : !hex && 'text-foreground',
    className,
  )
  const marks = {
    ...a11y,
    'data-platform': platform,
    ...(muted ? { 'data-muted': '' } : {}),
    className: classes,
    style: !muted && hex ? { color: readableBrand(hex, light) } : undefined,
  }
  if (logo) {
    return (
      // Simple Icons fill their 24px box edge to edge; the margin sizes them
      // like the Phosphor logos beside them.
      <svg viewBox="-3 -3 30 30" fill="currentColor" {...marks} data-distro={known.id}>
        <title>{name}</title>
        <path d={logo.path} />
      </svg>
    )
  }
  return <Glyph weight="fill" alt={name} {...marks} />
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
