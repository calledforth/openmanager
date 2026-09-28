import { posix } from 'node:path'
import type { ServerConfig } from '../config.ts'
import {
  ServiceError,
  trimOutput,
  type Context,
  type RunResult,
  type ServiceBackend,
} from './context.ts'
import { describeArguments, serverArguments } from './server-arguments.ts'
import {
  buildUnitFile,
  parseSystemctlShow,
  readUnitExecStart,
  servicePath,
  UNIT_NAME,
  unitFilePath,
  wslKeepsDistroRunning,
} from './systemd-unit.ts'

/**
 * Linux and WSL: a systemd user unit (docs/linux-systemd.md), managed through
 * `systemctl --user` and `loginctl`.
 */

const JOURNAL_COMMAND = `journalctl --user -u ${UNIT_NAME}`

const WSL_WITHOUT_SYSTEMD = [
  'This WSL distro runs without systemd, so there is no user service manager to install into.',
  'Turn systemd on: add these lines to /etc/wsl.conf (with sudo), run "wsl.exe --shutdown"',
  'from Windows, reopen the distro, and run "service install" again:',
  '  [boot]',
  '  systemd=true',
  'This needs WSL 0.67.6 or later ("wsl.exe --version"). See docs/linux-systemd.md.',
].join('\n')

/** States in which stopping the unit ends a server process. */
const RUNNING_STATES = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing'])

type Linger = 'on' | 'off' | 'unknown'

/** WSL interop can wedge after a WSL update; the lookup is advice, not worth waiting on. */
const INTEROP_TIMEOUT_MS = 5000

interface WslConfig {
  /** Where the file is, as Windows names it. */
  windowsPath: string | undefined
  keepsRunning: boolean
}

/** Runs a system tool, turning a missing binary into an explanation. */
async function tool(context: Context, file: string, args: readonly string[]): Promise<RunResult> {
  try {
    return await context.run(file, args)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ServiceError(
        `${file} was not found. The service commands need systemd's ${file} on PATH.`,
      )
    }
    throw error
  }
}

function systemctl(context: Context, args: readonly string[]): Promise<RunResult> {
  return tool(context, 'systemctl', ['--user', ...args])
}

async function systemctlChecked(context: Context, args: readonly string[], action: string) {
  const result = await systemctl(context, args)
  if (result.code !== 0) {
    throw new ServiceError(`systemd could not ${action}: ${trimOutput(result)}`)
  }
  return result
}

async function unitProperty(context: Context, property: string): Promise<string | undefined> {
  const result = await systemctl(context, ['show', UNIT_NAME, `--property=${property}`, '--value'])
  return result.code === 0 ? result.stdout.trim() : undefined
}

async function isWsl(context: Context): Promise<boolean> {
  if (context.env.WSL_DISTRO_NAME) return true
  const release = await context.readFile('/proc/sys/kernel/osrelease')
  return release !== undefined && /microsoft/i.test(release)
}

async function loginctl(context: Context, args: readonly string[]): Promise<RunResult> {
  return context.run('loginctl', args).catch((error: unknown) => ({
    code: 1,
    stdout: '',
    stderr:
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'loginctl was not found'
        : error instanceof Error
          ? error.message
          : String(error),
  }))
}

async function lingerState(context: Context): Promise<{ linger: Linger; detail: string }> {
  const result = await loginctl(context, [
    'show-user',
    context.username,
    '--property=Linger',
    '--value',
  ])
  if (result.code === 0) {
    return { linger: result.stdout.trim() === 'yes' ? 'on' : 'off', detail: '' }
  }
  // logind has no record of a user without sessions or linger: that is "off".
  if (/not logged in or lingering/i.test(result.stderr)) return { linger: 'off', detail: '' }
  return { linger: 'unknown', detail: trimOutput(result) }
}

/**
 * `loginctl` needs the user named explicitly: on systemd 255 a bare
 * `enable-linger` inside a WSL session prints "No such device or address"
 * and still exits 0, so the result is always read back rather than trusted.
 */
async function ensureLinger(context: Context): Promise<{ linger: Linger; detail: string }> {
  const before = await lingerState(context)
  if (before.linger === 'on') return before
  const result = await loginctl(context, ['enable-linger', context.username])
  const after = await lingerState(context)
  if (after.linger === 'on') return after
  return { linger: after.linger, detail: trimOutput(result) || after.detail }
}

function lingerText(context: Context, { linger, detail }: { linger: Linger; detail: string }) {
  const suffix = detail ? ` (${detail})` : ''
  if (linger === 'on') return 'on: the server starts at boot and keeps running after you log out'
  const fix = `turn it on with "sudo loginctl enable-linger ${context.username}"`
  if (linger === 'off') return `off: the server stops when you log out; ${fix}${suffix}`
  return `unknown: loginctl could not report it${suffix}; without linger the server stops when you log out`
}

/**
 * Finds the Windows user's `.wslconfig` through interop: `%USERPROFILE%` from
 * `cmd.exe`, translated by `wslpath`. `undefined` when interop is off or the
 * lookup fails, in which case the caller gives the general advice.
 */
async function readWslConfig(context: Context): Promise<WslConfig | undefined> {
  try {
    const timeout = { timeoutMs: INTEROP_TIMEOUT_MS }
    const echoed = await context.run('cmd.exe', ['/d', '/c', 'echo', '%USERPROFILE%'], timeout)
    const profile = echoed.stdout.trim()
    if (echoed.code !== 0 || !/^[A-Za-z]:\\/.test(profile)) return undefined
    const translated = await context.run('wslpath', ['-u', profile], timeout)
    const directory = translated.stdout.trim()
    if (translated.code !== 0 || !directory.startsWith('/')) return undefined
    const text = await context.readFile(posix.join(directory, '.wslconfig'))
    return {
      windowsPath: `${profile}\\.wslconfig`,
      keepsRunning: text !== undefined && wslKeepsDistroRunning(text),
    }
  } catch {
    return undefined
  }
}

function wslText(config: WslConfig | undefined): string {
  const where = config?.windowsPath ?? '%UserProfile%\\.wslconfig'
  if (config?.keepsRunning) {
    return `the distro keeps running with no terminal open (instanceIdleTimeout=-1 in ${where})`
  }
  return `Windows shuts this distro down about 15 s after its last terminal closes, and the server with it. Keep it running with "instanceIdleTimeout=-1" under [general] in ${where}, then run "wsl.exe --shutdown".`
}

export function createSystemdBackend(context: Context): ServiceBackend {
  // Settled in preflight from the user manager's own environment: the shell's
  // XDG_CONFIG_HOME (say, from .bashrc) need not match the directory systemd
  // actually searches, and every command must agree on one file.
  let unitPath = unitFilePath({}, context.homedir)

  return {
    kind: 'systemd user unit',
    label: `systemd user unit ${UNIT_NAME}`,
    restartHint:
      'It starts again with your user service manager (at boot with linger on) or with "service start".',

    async preflight() {
      if (context.uid === 0) {
        throw new ServiceError(
          'Run the service commands as the user whose provider logins the environment should use, not as root or through sudo.',
        )
      }
      const init = (await context.readFile('/proc/1/comm'))?.trim()
      if (init !== undefined && init !== 'systemd') {
        if (await isWsl(context)) throw new ServiceError(WSL_WITHOUT_SYSTEMD)
        throw new ServiceError(
          `This system's init is ${init}, not systemd, so there is no user service manager. Run "node apps/server/dist/main.js" under your own supervisor instead.`,
        )
      }
      const probe = await systemctl(context, ['show', '--property=Version'])
      if (probe.code !== 0) {
        throw new ServiceError(
          `systemctl --user could not reach your user service manager: ${trimOutput(probe)}. Run this as yourself from a normal login shell (not through sudo or su), so XDG_RUNTIME_DIR and the user bus are set.`,
        )
      }
      const manager = await systemctl(context, ['show-environment'])
      if (manager.code === 0) {
        unitPath = unitFilePath(parseSystemctlShow(manager.stdout), context.homedir)
      }
    },

    async running() {
      // is-active always prints a state; no output means systemd was not reached.
      const state = (await systemctl(context, ['is-active', UNIT_NAME])).stdout.trim()
      return state === '' ? undefined : state === 'active'
    },

    async read() {
      const text = await context.readFile(unitPath)
      if (text === undefined) return undefined
      return describeArguments((readUnitExecStart(text) ?? []).slice(2))
    },

    async register(config: ServerConfig, logFile: string) {
      const lineBreak = [context.execPath, context.entry, config.dataDir, logFile].find((value) =>
        /[\r\n]/.test(value),
      )
      if (lineBreak !== undefined) {
        throw new ServiceError(
          `A unit file cannot hold a path with a line break: ${JSON.stringify(lineBreak)}.`,
        )
      }
      const unit = buildUnitFile({
        execStart: [context.execPath, context.entry, ...serverArguments(config, logFile)],
        workingDirectory: config.dataDir,
        path: servicePath(context.env.PATH, context.execPath),
      })
      await context.ensureDir(posix.dirname(unitPath))
      await context.writeFile(unitPath, unit)
      await systemctlChecked(context, ['daemon-reload'], 'reload its unit files')
      const loadState = (await unitProperty(context, 'LoadState')) ?? 'unknown'
      if (loadState === 'not-found') {
        throw new ServiceError(
          `Wrote ${unitPath}, but your user service manager does not see it after a reload. See "systemctl --user status ${UNIT_NAME}" and "systemctl --user show-environment".`,
        )
      }
      if (loadState !== 'loaded') {
        throw new ServiceError(
          `systemd rejected ${unitPath} (${loadState}). See "systemctl --user status ${UNIT_NAME}".`,
        )
      }
      await systemctlChecked(context, ['enable', UNIT_NAME], `enable ${UNIT_NAME}`)
      context.stdout(`Installed systemd user unit ${UNIT_NAME} at ${unitPath}.`)
      const notes = [`  Linger:    ${lingerText(context, await ensureLinger(context))}`]
      if (await isWsl(context)) notes.push(`  WSL:       ${wslText(await readWslConfig(context))}`)
      return notes
    },

    async start() {
      // A unit that hit its crash-restart limit refuses to start until reset.
      await systemctl(context, ['reset-failed', UNIT_NAME])
      const started = await systemctl(context, ['start', UNIT_NAME])
      if (started.code !== 0) {
        throw new ServiceError(
          `systemd could not start ${UNIT_NAME}: ${trimOutput(started)} See "${JOURNAL_COMMAND}".`,
        )
      }
    },

    /** `systemctl stop` sends SIGTERM and returns once the server has exited (or been killed). */
    async stop() {
      const running = RUNNING_STATES.has(
        (await systemctl(context, ['is-active', UNIT_NAME])).stdout.trim(),
      )
      const stopped = await systemctl(context, ['stop', UNIT_NAME])
      // A unit systemd cannot load has nothing running; failing here would
      // block the reinstall or uninstall that repairs it.
      if (stopped.code !== 0 && running) {
        throw new ServiceError(`systemd could not stop ${UNIT_NAME}: ${trimOutput(stopped)}`)
      }
      return running ? 'stopped' : 'not_running'
    },

    async remove() {
      await systemctl(context, ['reset-failed', UNIT_NAME])
      await systemctlChecked(context, ['disable', UNIT_NAME], `disable ${UNIT_NAME}`)
      await context.removeFile(unitPath)
      await systemctlChecked(context, ['daemon-reload'], 'reload its unit files')
    },

    async status() {
      const shown = await systemctl(context, [
        'show',
        UNIT_NAME,
        '--property=LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainStatus,ExecMainExitTimestamp,NRestarts',
      ])
      const unit = parseSystemctlShow(shown.code === 0 ? shown.stdout : '')
      const lines = [
        `Unit:      ${UNIT_NAME} (${unit.ActiveState ?? 'unknown'}, ${unit.SubState ?? 'unknown'}; ${
          unit.UnitFileState || 'unknown'
        })`,
      ]
      if (unit.LoadState && unit.LoadState !== 'loaded') {
        lines.push(
          `Unit file: ${unit.LoadState}; systemd cannot use ${unitPath}. See "systemctl --user status ${UNIT_NAME}", then run "service install" again.`,
        )
      }
      if (unit.ExecMainExitTimestamp && unit.ActiveState !== 'active') {
        const result = unit.Result && unit.Result !== 'success' ? ` (${unit.Result})` : ''
        lines.push(
          `Last exit: ${unit.ExecMainExitTimestamp}, status ${unit.ExecMainStatus ?? '?'}${result}`,
        )
      }
      if (Number(unit.NRestarts) > 0) {
        lines.push(`Restarts:  ${unit.NRestarts} after failures since the unit was started`)
      }
      lines.push(`Linger:    ${lingerText(context, await lingerState(context))}`)
      if (await isWsl(context)) lines.push(`WSL:       ${wslText(await readWslConfig(context))}`)
      lines.push(`Journal:   ${JOURNAL_COMMAND}`)
      return lines
    },
  }
}
