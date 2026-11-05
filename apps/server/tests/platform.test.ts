import { describe, expect, it } from 'vitest'
import { detectEnvironmentPlatform } from '../src/platform.js'

const probe = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, kernelRelease?: string) => ({
  platform,
  env,
  kernelRelease: () => kernelRelease,
})

describe('detectEnvironmentPlatform', () => {
  it('names Windows and macOS by their Node platform', () => {
    expect(detectEnvironmentPlatform(probe('win32'))).toBe('windows')
    expect(detectEnvironmentPlatform(probe('darwin'))).toBe('macos')
  })

  it('tells WSL from Linux by the distro name or the kernel release', () => {
    expect(detectEnvironmentPlatform(probe('linux', { WSL_DISTRO_NAME: 'Ubuntu' }))).toBe('wsl')
    expect(
      detectEnvironmentPlatform(probe('linux', {}, '6.6.87.2-microsoft-standard-WSL2\n')),
    ).toBe('wsl')
    expect(detectEnvironmentPlatform(probe('linux', {}, '6.18.0-generic\n'))).toBe('linux')
    expect(detectEnvironmentPlatform(probe('linux'))).toBe('linux')
  })

  it('names no platform clients have no word for', () => {
    expect(detectEnvironmentPlatform(probe('freebsd'))).toBeUndefined()
  })
})
