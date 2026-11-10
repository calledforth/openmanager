import { readFileSync } from 'node:fs'
import {
  parseEnvironmentDistro,
  type EnvironmentDistro,
  type EnvironmentPlatform,
} from '@openmanager/protocol'

type PlatformProbe = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** The kernel release, or undefined where it cannot be read. */
  kernelRelease: () => string | undefined
}

function readKernelRelease(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8')
  } catch {
    return undefined
  }
}

/**
 * What kind of machine this server runs on. Read once at boot: none of it
 * changes while the process lives. Undefined on a platform clients have no
 * name for, which they show as nothing rather than as a guess.
 */
export function detectEnvironmentPlatform(
  probe: PlatformProbe = {
    platform: process.platform,
    env: process.env,
    kernelRelease: readKernelRelease,
  },
): EnvironmentPlatform | undefined {
  switch (probe.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux': {
      // The same check as the systemd service: WSL sets the distro name for
      // its shells, and its kernel names Microsoft for everything else.
      if (probe.env.WSL_DISTRO_NAME) return 'wsl'
      const release = probe.kernelRelease()
      return release !== undefined && /microsoft/i.test(release) ? 'wsl' : 'linux'
    }
    default:
      return undefined
  }
}

function readOsRelease(): string | undefined {
  // The first is the admin's, the second the vendor's default (os-release(5)).
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // Try the next one.
    }
  }
  return undefined
}

/** os-release's `KEY=value` lines, the value unquoted (os-release(5)). */
function parseOsRelease(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2]!
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\(["\\`$])/g, '$1')
    }
    fields.set(match[1]!, value)
  }
  return fields
}

/**
 * Which Linux distribution this server runs, for clients to show its logo.
 * Read once at boot. Only for Linux and WSL, and undefined when os-release is
 * missing or names nothing usable.
 */
export function detectEnvironmentDistro(
  platform: EnvironmentPlatform | undefined,
  osRelease: () => string | undefined = readOsRelease,
): EnvironmentDistro | undefined {
  if (platform !== 'linux' && platform !== 'wsl') return undefined
  const text = osRelease()
  if (text === undefined) return undefined
  const fields = parseOsRelease(text)
  return parseEnvironmentDistro({
    id: fields.get('ID')?.toLowerCase(),
    name: fields.get('NAME'),
    like: fields.get('ID_LIKE')?.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8),
  })
}
