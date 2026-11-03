import { readFileSync } from 'node:fs'
import type { EnvironmentPlatform } from '@openmanager/protocol'

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
