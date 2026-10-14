import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runActivate,
  runUninstall,
  runUpdate,
  type RunResult,
  type StandaloneDeps,
} from '../src/standalone/commands.js'
import {
  defaultBinDir,
  defaultInstallRoot,
  installedCopy,
  launcherRootExpression,
  pathContains,
  windowsLauncher,
} from '../src/standalone/layout.js'
import {
  archiveName,
  compareVersions,
  fetchNewestRelease,
  newestRelease,
  parseChecksums,
  releaseTarget,
} from '../src/standalone/release.js'

describe('install layout', () => {
  it('finds the install an executable belongs to from its path', () => {
    expect(
      installedCopy(
        'C:\\Users\\Ada\\AppData\\Local\\OpenManager\\versions\\0.2.0\\openmanager.exe',
        'win32',
      ),
    ).toEqual({
      root: 'C:\\Users\\Ada\\AppData\\Local\\OpenManager',
      version: '0.2.0',
      versionsDir: 'C:\\Users\\Ada\\AppData\\Local\\OpenManager\\versions',
      versionDir: 'C:\\Users\\Ada\\AppData\\Local\\OpenManager\\versions\\0.2.0',
    })
    expect(
      installedCopy(
        '/home/ada/.local/share/openmanager/versions/1.0.0-beta.1/openmanager',
        'linux',
      ),
    ).toMatchObject({ root: '/home/ada/.local/share/openmanager', version: '1.0.0-beta.1' })
    expect(installedCopy('C:\\tools\\openmanager.exe', 'win32')).toBeUndefined()
    expect(installedCopy('/opt/versions/latest/openmanager', 'linux')).toBeUndefined()
  })

  it('defaults to LOCALAPPDATA on Windows and XDG data plus ~/.local/bin on Linux', () => {
    expect(defaultInstallRoot('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\Ada')).toBe(
      'C:\\L\\OpenManager',
    )
    expect(defaultInstallRoot('linux', {}, '/home/ada')).toBe('/home/ada/.local/share/openmanager')
    expect(defaultInstallRoot('linux', { XDG_DATA_HOME: '/x' }, '/home/ada')).toBe('/x/openmanager')
    expect(defaultInstallRoot('linux', { OPENMANAGER_INSTALL_DIR: '/o' }, '/home/ada')).toBe('/o')
    expect(defaultBinDir('win32', {}, 'C:\\Users\\Ada', 'C:\\L\\OpenManager')).toBe(
      'C:\\L\\OpenManager\\bin',
    )
    expect(defaultBinDir('linux', {}, '/home/ada', '/r')).toBe('/home/ada/.local/bin')
  })

  it('compares PATH entries the way each platform does', () => {
    expect(
      pathContains('C:\\a;C:\\L\\OpenManager\\bin\\;C:\\b', 'c:\\l\\openmanager\\bin', 'win32'),
    ).toBe(true)
    expect(pathContains('/usr/bin:/home/ada/.local/bin/', '/home/ada/.local/bin', 'linux')).toBe(
      true,
    )
    expect(pathContains('/usr/bin:/home/ADA/.local/bin', '/home/ada/.local/bin', 'linux')).toBe(
      false,
    )
    expect(pathContains(undefined, '/x', 'linux')).toBe(false)
  })

  it('writes a cmd launcher whose text does not depend on the version', () => {
    expect(windowsLauncher('C:\\L\\OpenManager')).toBe(
      [
        '@echo off',
        'setlocal',
        'set /p OPENMANAGER_VERSION=<"C:\\L\\OpenManager\\current"',
        '"C:\\L\\OpenManager\\versions\\%OPENMANAGER_VERSION%\\openmanager.exe" %*',
        '',
      ].join('\r\n'),
    )
  })
})

describe('launcher text', () => {
  it('names the install folder without literal non-ASCII text or bare percent signs', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\José\\AppData\\Local' }
    const root = 'C:\\Users\\José\\AppData\\Local\\OpenManager'
    expect(launcherRootExpression(root, `${root}\\bin`, env)).toBe('%~dp0..')
    expect(launcherRootExpression(root, 'C:\\tools', env)).toBe('%LOCALAPPDATA%\\OpenManager')
    expect(launcherRootExpression('D:\\100%\\OpenManager', 'C:\\tools', {})).toBe(
      'D:\\100%%\\OpenManager',
    )
  })
})

describe('releases', () => {
  it('names one archive per supported target', () => {
    expect(releaseTarget('win32', 'x64')).toBe('win32-x64')
    expect(releaseTarget('linux', 'arm64')).toBe('linux-arm64')
    expect(releaseTarget('darwin', 'arm64')).toBeUndefined()
    expect(releaseTarget('win32', 'arm64')).toBeUndefined()
    expect(archiveName('0.2.0', 'win32-x64')).toBe('openmanager-0.2.0-win32-x64.zip')
    expect(archiveName('0.2.0', 'linux-x64')).toBe('openmanager-0.2.0-linux-x64.tar.gz')
  })

  it('orders versions numerically, with prereleases before their release', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-rc-2', '1.2.3-rc-1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('picks the newest published server release and ignores desktop tags', () => {
    const listing = [
      { tag_name: 'v0.9.0', draft: false, prerelease: false },
      { tag_name: 'server-v0.2.0', draft: false, prerelease: false },
      { tag_name: 'server-v0.10.0', draft: true, prerelease: false },
      { tag_name: 'server-v0.3.0-beta.1', draft: false, prerelease: true },
      { tag_name: 'server-v0.1.0', draft: false, prerelease: false },
    ]
    expect(newestRelease(listing)).toBe('0.2.0')
    expect(newestRelease(listing, true)).toBe('0.3.0-beta.1')
    expect(newestRelease({ message: 'rate limited' })).toBeUndefined()
  })

  it('reads further pages when desktop releases fill the first one', async () => {
    const pages = new Map<string, unknown>([
      ['1', Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.9.${index}` }))],
      ['2', [{ tag_name: 'v0.1.0' }, { tag_name: 'server-v0.4.0' }, { tag_name: 'server-v0.3.0' }]],
    ])
    const requested: string[] = []
    const fake = (async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get('page')!
      requested.push(page)
      return Response.json(pages.get(page) ?? [])
    }) as typeof fetch
    expect(await fetchNewestRelease(fake, {})).toBe('0.4.0')
    expect(requested).toEqual(['1', '2'])
    await expect(fetchNewestRelease(async () => Response.json([]), {})).rejects.toThrow(
      'no published OpenManager server release',
    )
  })

  it('reads sha256sum output, with or without the binary marker', () => {
    const hash = 'a'.repeat(64)
    expect(parseChecksums(`${hash}  one.zip\r\n${'B'.repeat(64)} *two.tar.gz\nnoise\n`)).toEqual(
      new Map([
        ['one.zip', hash],
        ['two.tar.gz', 'b'.repeat(64)],
      ]),
    )
  })
})

const exeName = process.platform === 'win32' ? 'openmanager.exe' : 'openmanager'
const launcherFile = process.platform === 'win32' ? 'openmanager.cmd' : 'openmanager'
const target = releaseTarget(process.platform, process.arch)

/** A real install folder in a temp directory, with scripted processes and downloads. */
function fakeInstall(options: {
  version?: string
  /** What `<exe> service status --json` prints; no service when undefined. */
  serviceProgram?: string[]
  /** Release files served by the fake download host, by name. */
  release?: Map<string, Buffer>
  newest?: string
  /** Exit code of `<new exe> service update`. */
  serviceUpdateCode?: number
  /** `service status --json` fails before printing JSON (no user bus, say). */
  statusFails?: boolean
}) {
  const temp = mkdtempSync(join(tmpdir(), 'om-standalone-'))
  const root = join(temp, 'OpenManager')
  const version = options.version ?? '0.1.0'
  const versionDir = join(root, 'versions', version)
  mkdirSync(versionDir, { recursive: true })
  const execPath = join(versionDir, exeName)
  writeFileSync(execPath, 'old')
  const binDir = join(temp, 'bin')
  const out: string[] = []
  const err: string[] = []
  const attachedCalls: string[][] = []
  const runCalls: string[][] = []
  const serviceCalls: string[][] = []
  const run = async (file: string, args: readonly string[]): Promise<RunResult> => {
    runCalls.push([file, ...args])
    if (file.endsWith(exeName)) {
      if (args[0] === '--version') {
        return { code: 0, stdout: `${readFileSync(file, 'utf8')}\n`, stderr: '' }
      }
      if (args.join(' ') === 'service status --json') {
        if (options.statusFails) {
          return {
            code: 1,
            stdout: '',
            stderr: 'systemctl --user could not reach your user service manager',
          }
        }
        return options.serviceProgram
          ? {
              code: 0,
              stdout: JSON.stringify({ installed: true, program: options.serviceProgram }),
              stderr: '',
            }
          : { code: 1, stdout: JSON.stringify({ installed: false }), stderr: '' }
      }
    }
    if (file.endsWith('tar.exe') || file === 'tar') {
      const result = spawnSync(file, args, { encoding: 'utf8' })
      return { code: result.status, stdout: result.stdout, stderr: result.stderr }
    }
    if (file === 'powershell.exe') return { code: 0, stdout: '', stderr: '' }
    throw new Error(`unexpected run ${file} ${args.join(' ')}`)
  }
  const deps: StandaloneDeps = {
    platform: process.platform,
    arch: process.arch,
    env: {
      OPENMANAGER_BIN_DIR: binDir,
      OPENMANAGER_RELEASE_BASE_URL: 'https://downloads.test',
      PATH: '',
    },
    homedir: temp,
    execPath,
    standalone: true,
    version,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/')) {
        return Response.json([
          { tag_name: `server-v${options.newest ?? version}`, draft: false, prerelease: false },
        ])
      }
      const name = url.split('/').at(-1)!
      const body = options.release?.get(name)
      return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 })
    }) as typeof fetch,
    run,
    runAttached: async (file, args) => {
      attachedCalls.push([file, ...args])
      return options.serviceUpdateCode ?? 0
    },
    service: async (args) => {
      serviceCalls.push([...args])
      return 0
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  }
  return { temp, root, binDir, execPath, deps, out, err, attachedCalls, runCalls, serviceCalls }
}

/** A release archive holding an `openmanager` whose `--version` prints `version`. */
function buildRelease(version: string): Map<string, Buffer> {
  const staging = mkdtempSync(join(tmpdir(), 'om-release-'))
  try {
    writeFileSync(join(staging, exeName), version)
    const name = archiveName(version, target!)
    const archive = join(staging, name)
    const result =
      process.platform === 'win32'
        ? spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), [
            '-a',
            '-cf',
            archive,
            '-C',
            staging,
            exeName,
          ])
        : spawnSync('tar', ['-czf', archive, '-C', staging, exeName])
    if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr)}`)
    const bytes = readFileSync(archive)
    const sum = createHash('sha256').update(bytes).digest('hex')
    return new Map([
      [name, bytes],
      ['SHA256SUMS', Buffer.from(`${sum}  ${name}\n`)],
    ])
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

const cleanups: string[] = []
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** The executable the launcher runs now. */
function launcherTarget(system: {
  binDir: string
  root: string
  deps: { env: NodeJS.ProcessEnv }
}): string {
  const launcher = join(system.binDir, launcherFile)
  if (process.platform === 'win32') {
    expect(readFileSync(launcher, 'utf8')).toBe(
      windowsLauncher(launcherRootExpression(system.root, system.binDir, system.deps.env)),
    )
    const version = readFileSync(join(system.root, 'current'), 'utf8')
    return join(system.root, 'versions', version, exeName)
  }
  expect(lstatSync(launcher).isSymbolicLink()).toBe(true)
  return readlinkSync(launcher)
}

describe.skipIf(target === undefined)('standalone commands', () => {
  it('refuses to manage an install from a checkout or a moved executable', async () => {
    const system = fakeInstall({})
    cleanups.push(system.temp)
    expect(await runUpdate([], { ...system.deps, standalone: false })).toBe(1)
    expect(system.err[0]).toContain('From a checkout')
    expect(await runUninstall([], { ...system.deps, execPath: join(system.temp, exeName) })).toBe(1)
    expect(system.err[1]).toContain('is not inside an OpenManager install')
  })

  it('activate points the launcher at this version and leaves a matching service alone', async () => {
    const system = fakeInstall({})
    cleanups.push(system.temp)
    system.deps.env.PATH = system.binDir
    expect(await runActivate([], { ...system.deps })).toBe(0)
    expect(launcherTarget(system)).toBe(system.execPath)
    expect(JSON.parse(readFileSync(join(system.root, 'install.json'), 'utf8'))).toMatchObject({
      binDir: system.binDir,
      version: '0.1.0',
    })
    expect(system.out).toEqual([
      `OpenManager 0.1.0 is installed: ${join(system.binDir, launcherFile)}`,
    ])
    expect(system.attachedCalls).toEqual([])
  })

  it('activate moves a service that still runs another build', async () => {
    const system = fakeInstall({ serviceProgram: ['/usr/bin/node', '/src/dist/main.js'] })
    cleanups.push(system.temp)
    expect(await runActivate([], system.deps)).toBe(0)
    expect(system.attachedCalls).toEqual([[system.execPath, 'service', 'update']])
    expect(system.out.at(-1)).toContain('PATH')
  })

  it('update downloads, verifies and unpacks the newest release, then moves the service', async () => {
    const system = fakeInstall({
      newest: '0.2.0',
      release: buildRelease('0.2.0'),
      serviceProgram: ['x'],
    })
    cleanups.push(system.temp)
    expect(await runUpdate([], system.deps)).toBe(0)
    const next = join(system.root, 'versions', '0.2.0', exeName)
    expect(readFileSync(next, 'utf8')).toBe('0.2.0')
    expect(readFileSync(join(system.root, 'versions', '0.2.0', '.install-complete'), 'utf8')).toBe(
      '0.2.0',
    )
    expect(launcherTarget(system)).toBe(next)
    expect(system.attachedCalls).toEqual([[next, 'service', 'update']])
    // The version moved from stays for a manual rollback.
    expect(existsSync(system.execPath)).toBe(true)
  })

  it('update keeps everything when the checksum does not match', async () => {
    const release = buildRelease('0.2.0')
    release.set('SHA256SUMS', Buffer.from(`${'0'.repeat(64)}  ${archiveName('0.2.0', target!)}\n`))
    const system = fakeInstall({ newest: '0.2.0', release })
    cleanups.push(system.temp)
    expect(await runUpdate([], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Checksum mismatch')
    expect(existsSync(join(system.root, 'versions', '0.2.0'))).toBe(false)
    expect(existsSync(join(system.binDir, launcherFile))).toBe(false)
  })

  it('update on the newest version only moves a lagging service', async () => {
    const system = fakeInstall({ newest: '0.1.0' })
    cleanups.push(system.temp)
    expect(await runUpdate([], system.deps)).toBe(0)
    expect(system.out[0]).toBe('OpenManager 0.1.0 is already the newest version.')
    expect(system.runCalls.some((call) => call[1] === 'service')).toBe(true)
    expect(system.attachedCalls).toEqual([])
  })

  it('a failed service handoff keeps both versions', async () => {
    const system = fakeInstall({
      newest: '0.2.0',
      release: buildRelease('0.2.0'),
      serviceProgram: ['x'],
      serviceUpdateCode: 1,
    })
    cleanups.push(system.temp)
    expect(await runUpdate([], system.deps)).toBe(1)
    expect(existsSync(system.execPath)).toBe(true)
    expect(existsSync(join(system.root, 'versions', '0.2.0', exeName))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'uninstall removes the service, the launcher and the install, never the data',
    async () => {
      const system = fakeInstall({ serviceProgram: ['x'] })
      cleanups.push(system.temp)
      const dataDir = join(system.temp, '.openmanager')
      mkdirSync(dataDir)
      expect(await runActivate([], system.deps)).toBe(0)
      expect(await runUninstall([], system.deps)).toBe(0)
      expect(system.serviceCalls).toEqual([['uninstall']])
      expect(existsSync(join(system.binDir, launcherFile))).toBe(false)
      expect(existsSync(system.root)).toBe(false)
      expect(existsSync(dataDir)).toBe(true)
    },
  )

  it('activate keeps this version and the one before it, and prunes older ones', async () => {
    const system = fakeInstall({ version: '0.3.0' })
    cleanups.push(system.temp)
    for (const old of ['0.1.0', '0.2.0']) mkdirSync(join(system.root, 'versions', old))
    writeFileSync(
      join(system.root, 'install.json'),
      JSON.stringify({ binDir: system.binDir, version: '0.2.0' }),
    )
    expect(await runActivate([], system.deps)).toBe(0)
    expect(readdirSync(join(system.root, 'versions')).sort()).toEqual(['0.2.0', '0.3.0'])
  })

  it('refuses to run while another install holds the lock, and takes over a stale one', async () => {
    const system = fakeInstall({})
    cleanups.push(system.temp)
    writeFileSync(join(system.root, '.lock'), String(process.pid))
    expect(await runActivate([], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Another openmanager install or update is running')
    writeFileSync(join(system.root, '.lock'), '999999999')
    expect(await runActivate([], system.deps)).toBe(0)
    expect(existsSync(join(system.root, '.lock'))).toBe(false)
  })

  it('uninstall stops when the service cannot be checked, unless forced', async () => {
    const system = fakeInstall({ statusFails: true })
    cleanups.push(system.temp)
    expect(await runUninstall([], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Could not check for an installed background service')
    expect(existsSync(system.execPath)).toBe(true)
    // On Windows a detached helper deletes the folder; keep the test to the guard.
    if (process.platform === 'win32') return
    expect(await runUninstall(['--force'], system.deps)).toBe(0)
    expect(system.serviceCalls).toEqual([])
    expect(existsSync(system.execPath)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'uninstall deletes only what the layout owns, so a data folder inside it survives',
    async () => {
      const system = fakeInstall({})
      cleanups.push(system.temp)
      const data = join(system.root, 'data')
      mkdirSync(data)
      writeFileSync(join(data, 'identity.json'), '{}')
      expect(await runActivate([], system.deps)).toBe(0)
      expect(await runUninstall([], system.deps)).toBe(0)
      expect(existsSync(join(data, 'identity.json'))).toBe(true)
      expect(existsSync(join(system.root, 'versions'))).toBe(false)
      expect(existsSync(join(system.root, 'install.json'))).toBe(false)
    },
  )

  it('uninstall without a service skips the service step', async () => {
    const system = fakeInstall({})
    cleanups.push(system.temp)
    // Keep the folder on Windows, where uninstall hands deletion to a helper.
    if (process.platform === 'win32') return
    expect(await runUninstall([], system.deps)).toBe(0)
    expect(system.serviceCalls).toEqual([])
  })
})
