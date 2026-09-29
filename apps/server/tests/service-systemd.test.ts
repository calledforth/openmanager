import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultLogFile,
  runServiceCommand,
  type RunResult,
  type ServiceCommandDeps,
} from '../src/service/cli.js'
import {
  buildUnitFile,
  parseSystemctlShow,
  parseSystemdCommandLine,
  quoteSystemdArgument,
  readUnitExecStart,
  servicePath,
  UNIT_NAME,
  unitFilePath,
  wslKeepsDistroRunning,
} from '../src/service/systemd-unit.js'

const HOME = '/home/ada'
const NODE = '/home/ada/.nvm/versions/node/v24.21.0/bin/node'
const ENTRY = '/home/ada/src/openmanager/apps/server/dist/main.js'
const DATA_DIR = '/home/ada/.openmanager'
const UNIT_PATH = `${HOME}/.config/systemd/user/${UNIT_NAME}`

describe('systemd unit helpers', () => {
  it.each([
    ['plain', 'plain'],
    ['/home/ada/My Repo', '"/home/ada/My Repo"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\slash', '"back\\\\slash"'],
    ['100%', '"100%%"'],
    ['$HOME', '"$$HOME"'],
    ["it's", '"it\'s"'],
    ['', '""'],
    ['/home/josé', '"/home/josé"'],
    ['two\nlines\tand tab', '"two\\nlines\\tand tab"'],
    ['~/-dash', '"~/-dash"'],
    ['\\%$$', '"\\\\%%$$$$"'],
  ])('quotes %j so systemd passes it through unchanged', (argument, quoted) => {
    expect(quoteSystemdArgument(argument)).toBe(quoted)
    expect(parseSystemdCommandLine(quoted)).toEqual([argument])
  })

  it('writes WorkingDirectory unquoted, escaping only specifiers, because systemd takes it verbatim', () => {
    const unit = buildUnitFile({
      execStart: [NODE, ENTRY],
      workingDirectory: '/home/josé/My Data $x 100%',
      path: '/usr/bin',
    })
    expect(unit).toContain('WorkingDirectory=/home/josé/My Data $x 100%%\n')
  })

  it('reads single-quoted words and C escapes from a hand-edited line', () => {
    expect(parseSystemdCommandLine(`/bin/node 'a b' "c\\td" %%x`)).toEqual([
      '/bin/node',
      'a b',
      'c\td',
      '%x',
    ])
  })

  it('writes a user unit that restarts on failure and is wanted by default.target', () => {
    const unit = buildUnitFile({
      execStart: [NODE, ENTRY, '--port', '43120', '--workspace', '/home/ada/My Repo'],
      workingDirectory: DATA_DIR,
      path: '/home/ada/bin:/usr/bin',
    })
    expect(unit).toContain(
      `ExecStart=${NODE} ${ENTRY} --port 43120 --workspace "/home/ada/My Repo"\n`,
    )
    expect(unit).toContain(`WorkingDirectory=${DATA_DIR}\n`)
    expect(unit).toContain('Environment="PATH=/home/ada/bin:/usr/bin"\n')
    expect(unit).toContain('Type=exec\n')
    expect(unit).toContain('Restart=on-failure\n')
    expect(unit).toContain('KillMode=mixed\n')
    expect(unit).toContain('[Install]\nWantedBy=default.target\n')
    expect(unit).not.toContain('\r')
    expect(readUnitExecStart(unit)).toEqual([
      NODE,
      ENTRY,
      '--port',
      '43120',
      '--workspace',
      '/home/ada/My Repo',
    ])
  })

  it('puts the unit under XDG_CONFIG_HOME when it is absolute', () => {
    expect(unitFilePath({}, HOME)).toBe(UNIT_PATH)
    expect(unitFilePath({ XDG_CONFIG_HOME: '/cfg' }, HOME)).toBe(`/cfg/systemd/user/${UNIT_NAME}`)
    expect(unitFilePath({ XDG_CONFIG_HOME: 'relative' }, HOME)).toBe(UNIT_PATH)
  })

  it('freezes the shell PATH with the Node directory first and no relative entries', () => {
    expect(servicePath('/home/ada/.local/bin:.:/usr/bin:/home/ada/.local/bin', NODE)).toBe(
      '/home/ada/.nvm/versions/node/v24.21.0/bin:/home/ada/.local/bin:/usr/bin:/usr/local/bin:/bin',
    )
    expect(servicePath(undefined, '/usr/bin/node')).toBe('/usr/bin:/usr/local/bin:/bin')
  })

  it('parses systemctl show output', () => {
    expect(
      parseSystemctlShow('ActiveState=active\nSubState=running\nExecMainExitTimestamp=\n'),
    ).toEqual({
      ActiveState: 'active',
      SubState: 'running',
      ExecMainExitTimestamp: '',
    })
  })

  it.each([
    ['[general]\r\ninstanceIdleTimeout=-1\r\n', true],
    ['\uFEFF[General]\n InstanceIdleTimeout = -1 # keep WSL up\n', true],
    ['[general]\ninstanceIdleTimeout=60000\n', false],
    ['[wsl2]\ninstanceIdleTimeout=-1\n', false],
    ['', false],
  ])('reads whether .wslconfig %j keeps idle distros running', (text, keeps) => {
    expect(wslKeepsDistroRunning(text)).toBe(keeps)
  })

  it('reads a UTF-16 .wslconfig that arrives as UTF-8 text', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('[general]\r\ninstanceIdleTimeout=-1\r\n', 'utf16le'),
    ])
    expect(wslKeepsDistroRunning(utf16.toString('utf8'))).toBe(true)
  })
})

interface FakeOptions {
  /** Contents of the unit file before the command runs. */
  unit?: string
  healthy?: () => boolean
  uid?: number
  /** `/proc/1/comm`. */
  init?: string
  wsl?: boolean
  /** Contents of the Windows user's `.wslconfig`; absent when undefined. */
  wslconfig?: string
  linger?: boolean
  /** `loginctl enable-linger` silently does nothing (polkit refuses). */
  lingerRefused?: boolean
  /** `systemctl --user` cannot reach the user manager. */
  noUserBus?: boolean
  /** `systemctl` is not installed. */
  noSystemctl?: boolean
  activeState?: string
  show?: string
  /** `LoadState` after `daemon-reload`; `loaded` by default. */
  loadState?: string
  /** What `systemctl --user show-environment` prints. */
  managerEnvironment?: string
  /** `systemctl start` fails. */
  startFails?: boolean
  /** WSL interop is off: `cmd.exe` cannot be found. */
  noInterop?: boolean
  /** `loginctl` is not installed. */
  noLoginctl?: boolean
}

/** A scripted systemd user manager, logind and WSL interop. */
function fakeSystemd(options: FakeOptions = {}) {
  const calls: string[][] = []
  const out: string[] = []
  const err: string[] = []
  const dirs: string[] = []
  const files = new Map<string, string>()
  files.set('/proc/1/comm', `${options.init ?? 'systemd'}\n`)
  files.set(
    '/proc/sys/kernel/osrelease',
    options.wsl ? '6.18.33.2-microsoft-standard-WSL2\n' : '6.8.0-45-generic\n',
  )
  if (options.unit !== undefined) files.set(UNIT_PATH, options.unit)
  if (options.wslconfig !== undefined) files.set('/mnt/c/Users/Ada/.wslconfig', options.wslconfig)
  let health = options.healthy ?? (() => false)
  let linger = options.linger ?? false
  let active = options.activeState ?? 'inactive'
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
  const run = async (file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push([file, ...args])
    if (file === 'systemctl') {
      if (options.noSystemctl) {
        throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' })
      }
      expect(args[0]).toBe('--user')
      if (options.noUserBus) {
        return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' }
      }
      const [verb] = args.slice(1)
      const loaded = (options.loadState ?? 'loaded') === 'loaded'
      if (verb === 'start') {
        if (options.startFails) {
          return { code: 1, stdout: '', stderr: 'Job for openmanager-server.service failed.' }
        }
        active = 'active'
        health = () => true
      }
      if (verb === 'stop') {
        if (!loaded) {
          return { code: 5, stdout: '', stderr: `Failed to stop ${UNIT_NAME}: Unit not loaded.` }
        }
        active = 'inactive'
        health = () => false
      }
      if (verb === 'show-environment') return ok(options.managerEnvironment ?? `HOME=${HOME}\n`)
      if (verb === 'is-active')
        return { code: active === 'active' ? 0 : 3, stdout: `${active}\n`, stderr: '' }
      if (verb === 'show' && args.includes('--property=LoadState'))
        return ok(`${options.loadState ?? 'loaded'}\n`)
      if (verb === 'show' && args[2] === UNIT_NAME) return ok(options.show ?? '')
      return ok()
    }
    if (file === 'loginctl' && options.noLoginctl) {
      throw Object.assign(new Error('spawn loginctl ENOENT'), { code: 'ENOENT' })
    }
    if (file === 'cmd.exe' && options.noInterop) {
      throw Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' })
    }
    if (file === 'loginctl') {
      if (args[0] === 'enable-linger') {
        if (options.lingerRefused) {
          return { code: 0, stdout: '', stderr: 'Could not enable linger: Access denied' }
        }
        linger = true
        return ok()
      }
      return ok(`${linger ? 'yes' : 'no'}\n`)
    }
    if (file === 'cmd.exe') return ok('C:\\Users\\Ada\r\n')
    if (file === 'wslpath') return ok('/mnt/c/Users/Ada\n')
    throw new Error(`unexpected command ${file} ${args.join(' ')}`)
  }
  const deps: ServiceCommandDeps = {
    entry: ENTRY,
    platform: 'linux',
    env: {
      PATH: '/home/ada/.local/bin:/usr/bin:/bin',
      ...(options.wsl ? { WSL_DISTRO_NAME: 'Ubuntu' } : {}),
    },
    execPath: NODE,
    uid: options.uid ?? 1000,
    username: 'ada',
    homedir: HOME,
    run,
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => void files.set(path, text),
    removeFile: async (path) => void files.delete(path),
    ensureDir: async (path) => void dirs.push(path),
    fetch: (async () => {
      if (!health()) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }) as typeof fetch,
    sleep: async () => undefined,
    now: (() => {
      let clock = 0
      return () => (clock += 500)
    })(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  }
  const systemctlVerbs = () =>
    calls.filter((call) => call[0] === 'systemctl').map((call) => call.slice(2).join(' '))
  return { deps, calls, out, err, dirs, files, systemctlVerbs }
}

const INSTALLED_UNIT = buildUnitFile({
  execStart: [
    NODE,
    ENTRY,
    '--port',
    '43120',
    '--data-dir',
    DATA_DIR,
    '--log-file',
    '/logs/server.log',
  ],
  workingDirectory: DATA_DIR,
  path: '/usr/bin',
})

describe('service commands on systemd', () => {
  it('updates only the executable and entry while retaining installed settings and environment', async () => {
    const original = INSTALLED_UNIT.replace(
      '--port 43120',
      '--allowed-origin https://example.com --workspace /repo --log-level debug --port 43120',
    )
    const system = fakeSystemd({ unit: original, healthy: () => true, activeState: 'active' })
    system.deps.entry = '/new build/$release/main.js'
    system.deps.execPath = '/new node/bin/node'
    system.deps.env = { OPENMANAGER_DATA_DIR: '/wrong', OPENMANAGER_PORT: '9999' }
    expect(await runServiceCommand(['update'], system.deps)).toBe(0)
    const updated = system.files.get(UNIT_PATH)!
    expect(readUnitExecStart(updated)).toEqual([
      system.deps.execPath,
      system.deps.entry,
      ...readUnitExecStart(original)!.slice(2),
    ])
    expect(updated.replace(/^ExecStart=.*$/m, '')).toBe(original.replace(/^ExecStart=.*$/m, ''))
    const verbs = system.systemctlVerbs()
    expect(verbs.indexOf(`stop ${UNIT_NAME}`)).toBeLessThan(verbs.indexOf('daemon-reload'))
    expect(verbs.indexOf('daemon-reload')).toBeLessThan(verbs.indexOf(`start ${UNIT_NAME}`))
    expect(system.dirs).toEqual([])
  })

  it('keeps the updated registration and data when the new binary fails to start', async () => {
    const system = fakeSystemd({ unit: INSTALLED_UNIT, startFails: true })
    system.deps.entry = '/new/main.js'
    expect(await runServiceCommand(['update'], system.deps)).toBe(1)
    expect(readUnitExecStart(system.files.get(UNIT_PATH)!)![1]).toBe('/new/main.js')
    expect(system.err[0]).toContain('could not start')
    expect(system.dirs).toEqual([])
  })

  it('refuses missing data paths or ambiguous definitions before stopping', async () => {
    for (const unit of [
      INSTALLED_UNIT.replace(`--data-dir ${DATA_DIR}`, ''),
      `${INSTALLED_UNIT}\nExecStart=/other\n`,
      INSTALLED_UNIT.replace(/^(ExecStart=.*)$/m, '$1 \\\n  --allowed-origin https://example.com'),
    ]) {
      const system = fakeSystemd({ unit })
      expect(await runServiceCommand(['update'], system.deps)).toBe(1)
      expect(system.systemctlVerbs()).not.toContain(`stop ${UNIT_NAME}`)
      expect(system.files.get(UNIT_PATH)).toBe(unit)
    }
  })

  it('install stops before enabling when systemd does not see or rejects the written unit', async () => {
    const unseen = fakeSystemd({ loadState: 'not-found' })
    expect(await runServiceCommand(['install', '--port', '43121'], unseen.deps)).toBe(1)
    expect(unseen.err[0]).toContain('does not see it')
    expect(unseen.systemctlVerbs()).not.toContain(`enable ${UNIT_NAME}`)

    const rejected = fakeSystemd({ loadState: 'bad-setting' })
    expect(await runServiceCommand(['install', '--port', '43121'], rejected.deps)).toBe(1)
    expect(rejected.err[0]).toContain('rejected')
    expect(rejected.err[0]).toContain('bad-setting')
  })

  it("puts the unit where the user manager looks, whatever the shell's XDG_CONFIG_HOME says", async () => {
    const managerPath = `${HOME}/.cfg/systemd/user/${UNIT_NAME}`
    const system = fakeSystemd({
      managerEnvironment: `HOME=${HOME}\nXDG_CONFIG_HOME=${HOME}/.cfg\n`,
    })
    system.deps.env = { ...system.deps.env, XDG_CONFIG_HOME: '/somewhere/else' }
    expect(await runServiceCommand(['install', '--port', '43121'], system.deps)).toBe(0)
    expect(system.files.has(managerPath)).toBe(true)
    expect(system.files.has(UNIT_PATH)).toBe(false)
    expect(system.out[0]).toBe(`Installed systemd user unit ${UNIT_NAME} at ${managerPath}.`)
    // The other commands find the same file.
    expect(await runServiceCommand(['uninstall'], system.deps)).toBe(0)
    expect(system.files.has(managerPath)).toBe(false)
  })

  it('start and status do not mistake another server on the port for the unit', async () => {
    const system = fakeSystemd({ unit: INSTALLED_UNIT, healthy: () => true })
    expect(await runServiceCommand(['start'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('Something other than the systemd user unit answers')
    expect(system.systemctlVerbs()).not.toContain(`start ${UNIT_NAME}`)

    expect(await runServiceCommand(['status'], system.deps)).toBe(1)
    expect(system.out).toContain(
      'Server:    http://127.0.0.1:43120 (answering /health, but not from the systemd user unit)',
    )
  })

  it('a failed start points at the journal', async () => {
    const system = fakeSystemd({ startFails: true, linger: true })
    expect(await runServiceCommand(['install', '--port', '43121'], system.deps)).toBe(1)
    expect(system.err[0]).toContain('systemd could not start')
    expect(system.err[0]).toContain(`journalctl --user -u ${UNIT_NAME}`)
  })

  it('uninstall removes a unit systemd cannot load instead of failing on stop', async () => {
    const system = fakeSystemd({ unit: INSTALLED_UNIT, loadState: 'not-found' })
    expect(await runServiceCommand(['uninstall'], system.deps)).toBe(0)
    expect(system.files.has(UNIT_PATH)).toBe(false)
    expect(system.out[0]).toContain('the server was not running')
  })

  it('status flags a unit file systemd cannot use, and linger it cannot read', async () => {
    const system = fakeSystemd({
      unit: INSTALLED_UNIT,
      noLoginctl: true,
      show: 'LoadState=bad-setting\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n',
    })
    expect(await runServiceCommand(['status'], system.deps)).toBe(1)
    expect(system.out[1]).toContain('Unit file: bad-setting')
    expect(system.out[2]).toBe(
      'Linger:    unknown: loginctl could not report it (loginctl was not found); without linger the server stops when you log out',
    )
  })

  it('WSL advice falls back to the generic .wslconfig path when interop is off', async () => {
    const system = fakeSystemd({ wsl: true, noInterop: true })
    expect(await runServiceCommand(['install', '--port', '43121'], system.deps)).toBe(0)
    expect(system.out.find((line) => line.startsWith('  WSL:'))).toContain(
      '%UserProfile%\\.wslconfig',
    )
  })

  it('install writes the unit, enables it, turns linger on, starts it and waits for /health', async () => {
    const system = fakeSystemd()
    const dataDir = resolve(DATA_DIR)
    const code = await runServiceCommand(
      ['install', '--port', '43121', '--data-dir', DATA_DIR, '--workspace', '/home/ada/My Repo'],
      system.deps,
    )
    expect(system.err).toEqual([])
    expect(code).toBe(0)
    expect(system.systemctlVerbs()).toEqual([
      'show --property=Version',
      'show-environment',
      'daemon-reload',
      `show ${UNIT_NAME} --property=LoadState --value`,
      `enable ${UNIT_NAME}`,
      `reset-failed ${UNIT_NAME}`,
      `start ${UNIT_NAME}`,
    ])
    expect(system.calls).toContainEqual(['loginctl', 'enable-linger', 'ada'])
    expect(system.dirs).toEqual([dataDir, `${HOME}/.config/systemd/user`])

    const unit = system.files.get(UNIT_PATH)!
    expect(readUnitExecStart(unit)).toEqual([
      NODE,
      ENTRY,
      '--port',
      '43121',
      '--data-dir',
      dataDir,
      '--log-level',
      'info',
      '--workspace',
      resolve('/home/ada/My Repo'),
      '--log-file',
      defaultLogFile(dataDir),
    ])
    expect(unit).toContain(
      'Environment="PATH=/home/ada/.nvm/versions/node/v24.21.0/bin:/home/ada/.local/bin:/usr/bin:/bin:/usr/local/bin"',
    )
    expect(unit).not.toContain('--exit-with-parent')
    expect(system.out[0]).toBe(`Installed systemd user unit ${UNIT_NAME} at ${UNIT_PATH}.`)
    expect(system.out).toContain(
      '  Linger:    on: the server starts at boot and keeps running after you log out',
    )
    expect(system.out.some((line) => line.includes('WSL:'))).toBe(false)
    expect(system.out.at(-1)).toBe('Environment server is up at http://127.0.0.1:43121.')
  })

  it('install still succeeds when linger cannot be turned on, and says how to fix it', async () => {
    const system = fakeSystemd({ lingerRefused: true })
    expect(await runServiceCommand(['install', '--port', '43121'], system.deps)).toBe(0)
    const note = system.out.find((line) => line.startsWith('  Linger:'))!
    expect(note).toContain('stops when you log out')
    expect(note).toContain('sudo loginctl enable-linger ada')
    expect(note).toContain('Access denied')
  })

  it('install on WSL warns that the distro idles out unless .wslconfig keeps it running', async () => {
    const idle = fakeSystemd({ wsl: true })
    expect(await runServiceCommand(['install', '--port', '43121'], idle.deps)).toBe(0)
    const warning = idle.out.find((line) => line.startsWith('  WSL:'))!
    expect(warning).toContain('about 15 s after its last terminal closes')
    expect(warning).toContain('C:\\Users\\Ada\\.wslconfig')

    const kept = fakeSystemd({ wsl: true, wslconfig: '[general]\ninstanceIdleTimeout=-1\n' })
    expect(await runServiceCommand(['install', '--port', '43121'], kept.deps)).toBe(0)
    expect(kept.out.find((line) => line.startsWith('  WSL:'))).toContain(
      'keeps running with no terminal open',
    )
  })

  it('explains how to turn systemd on when WSL runs without it, before touching anything', async () => {
    const system = fakeSystemd({ wsl: true, init: 'init' })
    for (const command of ['install', 'status', 'start', 'stop', 'uninstall']) {
      expect(await runServiceCommand([command], system.deps)).toBe(1)
    }
    expect(system.err[0]).toContain('runs without systemd')
    expect(system.err[0]).toContain('[boot]\n  systemd=true')
    expect(system.err[0]).toContain('wsl.exe --shutdown')
    expect(system.err).toHaveLength(5)
    expect(system.calls).toEqual([])
    expect(system.files.has(UNIT_PATH)).toBe(false)
  })

  it('refuses root, non-systemd init, an unreachable user manager and a missing systemctl', async () => {
    const root = fakeSystemd({ uid: 0 })
    expect(await runServiceCommand(['install'], root.deps)).toBe(1)
    expect(root.err[0]).toContain('not as root')

    const openrc = fakeSystemd({ init: 'openrc-init' })
    expect(await runServiceCommand(['install'], openrc.deps)).toBe(1)
    expect(openrc.err[0]).toContain('init is openrc-init, not systemd')

    const noBus = fakeSystemd({ noUserBus: true })
    expect(await runServiceCommand(['status'], noBus.deps)).toBe(1)
    expect(noBus.err[0]).toContain('could not reach your user service manager')
    expect(noBus.err[0]).toContain('No medium found')

    const missing = fakeSystemd({ noSystemctl: true })
    expect(await runServiceCommand(['status'], missing.deps)).toBe(1)
    expect(missing.err[0]).toContain('systemctl was not found')
  })

  it('a replacement install stops the running unit before checking the port', async () => {
    const system = fakeSystemd({
      unit: INSTALLED_UNIT,
      activeState: 'active',
      healthy: () => true,
      linger: true,
    })
    expect(await runServiceCommand(['install', '--port', '43120'], system.deps)).toBe(0)
    expect(system.out[0]).toBe('Replacing the existing systemd user unit.')
    expect(system.systemctlVerbs().slice(0, 4)).toEqual([
      'show --property=Version',
      'show-environment',
      `is-active ${UNIT_NAME}`,
      `stop ${UNIT_NAME}`,
    ])
    expect(system.calls).not.toContainEqual(['loginctl', 'enable-linger', 'ada'])
  })

  it('uninstall stops, disables and deletes the unit and reloads systemd', async () => {
    const system = fakeSystemd({ unit: INSTALLED_UNIT, activeState: 'active' })
    expect(await runServiceCommand(['uninstall'], system.deps)).toBe(0)
    expect(system.systemctlVerbs()).toEqual([
      'show --property=Version',
      'show-environment',
      `is-active ${UNIT_NAME}`,
      `stop ${UNIT_NAME}`,
      `is-active ${UNIT_NAME}`,
      `reset-failed ${UNIT_NAME}`,
      `disable ${UNIT_NAME}`,
      'daemon-reload',
    ])
    expect(system.files.has(UNIT_PATH)).toBe(false)
    expect(system.out[0]).toBe(
      `Stopped the environment server and removed the systemd user unit ${UNIT_NAME}.`,
    )
    expect(system.out[1]).toContain(DATA_DIR)

    const again = fakeSystemd()
    expect(await runServiceCommand(['uninstall'], again.deps)).toBe(0)
    expect(again.out[0]).toContain('nothing to remove')
  })

  it('start and stop drive systemctl; stop reports a server that was not running', async () => {
    const system = fakeSystemd({ unit: INSTALLED_UNIT })
    expect(await runServiceCommand(['stop'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toBe('The environment server was not running.')
    expect(await runServiceCommand(['start'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toBe('Environment server is up at http://127.0.0.1:43120.')
    expect(await runServiceCommand(['stop'], system.deps)).toBe(0)
    expect(system.out.at(-1)).toContain('Stopped the environment server. It starts again')

    const none = fakeSystemd()
    expect(await runServiceCommand(['start'], none.deps)).toBe(1)
    expect(none.err[0]).toContain('service install')
  })

  it('status shows the unit, the last failure, linger, WSL idling and whether /health answers', async () => {
    const system = fakeSystemd({
      unit: INSTALLED_UNIT,
      wsl: true,
      show: [
        'ActiveState=failed',
        'SubState=failed',
        'UnitFileState=enabled',
        'Result=exit-code',
        'ExecMainStatus=1',
        'ExecMainExitTimestamp=Mon 2026-09-28 10:00:00 IST',
        'NRestarts=5',
      ].join('\n'),
    })
    expect(await runServiceCommand(['status'], system.deps)).toBe(1)
    expect(system.out).toEqual([
      `Unit:      ${UNIT_NAME} (failed, failed; enabled)`,
      'Last exit: Mon 2026-09-28 10:00:00 IST, status 1 (exit-code)',
      'Restarts:  5 after failures since the unit was started',
      'Linger:    off: the server stops when you log out; turn it on with "sudo loginctl enable-linger ada"',
      expect.stringContaining('WSL:       Windows shuts this distro down'),
      `Journal:   journalctl --user -u ${UNIT_NAME}`,
      'Server:    http://127.0.0.1:43120 (not answering)',
      `Data dir:  ${DATA_DIR}`,
      'Log file:  /logs/server.log',
      'State:     failed',
    ])
  })
})

describe('systemd maintenance', () => {
  it('restart preserves the unit and data and waits for health after stopping', async () => {
    const system = fakeSystemd({ unit: INSTALLED_UNIT, activeState: 'active', healthy: () => true })
    const before = new Map(system.files)
    expect(await runServiceCommand(['restart'], system.deps)).toBe(0)
    const verbs = system.systemctlVerbs()
    expect(verbs.indexOf(`stop ${UNIT_NAME}`)).toBeLessThan(verbs.indexOf(`start ${UNIT_NAME}`))
    expect(system.files).toEqual(before)
  })

  it.each([
    ['active', 'running', 0],
    ['inactive', 'stopped', 1],
    ['failed', 'failed', 1],
  ] as const)('normalizes %s status', async (active, state, code) => {
    const system = fakeSystemd({
      unit: INSTALLED_UNIT,
      activeState: active,
      show: `ActiveState=${active}\n`,
      healthy: () => active === 'active',
    })
    expect(await runServiceCommand(['status', '--json'], system.deps)).toBe(code)
    expect(JSON.parse(system.out[0]!)).toMatchObject({ state, installed: true })
  })

  it.each(['restart', 'uninstall'])(
    '%s retains registration when stop cannot be confirmed',
    async (command) => {
      const system = fakeSystemd({ unit: INSTALLED_UNIT, activeState: 'active' })
      const run = system.deps.run!
      system.deps.run = async (file, args) =>
        args[1] === 'stop' ? { code: 1, stdout: '', stderr: 'Access denied' } : run(file, args)
      expect(await runServiceCommand([command], system.deps)).toBe(1)
      expect(system.files.get(UNIT_PATH)).toBe(INSTALLED_UNIT)
      expect(system.systemctlVerbs()).not.toContain(`start ${UNIT_NAME}`)
      expect(system.systemctlVerbs()).not.toContain(`disable ${UNIT_NAME}`)
    },
  )
})
