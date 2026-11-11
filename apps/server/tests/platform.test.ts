import { describe, expect, it } from 'vitest'
import { detectEnvironmentDistro, detectEnvironmentPlatform } from '../src/platform.js'

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

describe('detectEnvironmentDistro', () => {
  const UBUNTU = [
    'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
    'NAME="Ubuntu"',
    'VERSION_ID="24.04"',
    'ID=ubuntu',
    'ID_LIKE=debian',
    '',
  ].join('\n')

  it('reads the ID, name and parents from os-release', () => {
    expect(detectEnvironmentDistro('wsl', () => UBUNTU)).toEqual({
      id: 'ubuntu',
      name: 'Ubuntu',
      like: ['debian'],
    })
    expect(
      detectEnvironmentDistro('linux', () => 'NAME=\'Pop!_OS\'\nID=pop\nID_LIKE="ubuntu debian"\n'),
    ).toEqual({ id: 'pop', name: 'Pop!_OS', like: ['ubuntu', 'debian'] })
    expect(detectEnvironmentDistro('linux', () => 'ID=arch\r\n')).toEqual({ id: 'arch' })
  })

  it('names none off Linux, without os-release, or for an ID that is not one', () => {
    expect(detectEnvironmentDistro('windows', () => UBUNTU)).toBeUndefined()
    expect(detectEnvironmentDistro('macos', () => UBUNTU)).toBeUndefined()
    expect(detectEnvironmentDistro(undefined, () => UBUNTU)).toBeUndefined()
    expect(detectEnvironmentDistro('linux', () => undefined)).toBeUndefined()
    expect(detectEnvironmentDistro('linux', () => 'NAME=Mystery\n')).toBeUndefined()
    expect(detectEnvironmentDistro('linux', () => 'ID="has spaces"\n')).toBeUndefined()
  })
})
