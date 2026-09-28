import { posix } from 'node:path'

/**
 * Pure helpers for the systemd user unit that keeps the environment server
 * running on Linux and WSL. Nothing here touches the system; the systemd
 * backend in `systemd.ts` writes the file and drives `systemctl --user`.
 *
 * Design record: docs/decisions/linux-systemd-user-unit.md.
 */

export const UNIT_NAME = 'openmanager-server.service'

export const UNIT_DESCRIPTION = 'OpenManager environment server'

/** `$XDG_CONFIG_HOME/systemd/user/<unit>`, the user unit directory systemd searches first. */
export function unitFilePath(env: NodeJS.ProcessEnv, home: string): string {
  const configHome = env.XDG_CONFIG_HOME?.startsWith('/')
    ? env.XDG_CONFIG_HOME
    : posix.join(home, '.config')
  return posix.join(configHome, 'systemd', 'user', UNIT_NAME)
}

/** Characters that never need quoting on an `ExecStart=` line. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_+=:,./@-]+$/

/**
 * Escape characters systemd would otherwise interpret: `\` and `"` inside a
 * quoted word, `%` specifiers, and `$` variable references. Control
 * characters are written as C escapes so a word stays on one line.
 */
function escapeWord(argument: string, expandsVariables: boolean): string {
  let escaped = ''
  for (const character of argument) {
    if (character === '\\' || character === '"') escaped += `\\${character}`
    else if (character === '%') escaped += '%%'
    else if (character === '$' && expandsVariables) escaped += '$$'
    else if (character === '\n') escaped += '\\n'
    else if (character === '\t') escaped += '\\t'
    else if (character === '\r') escaped += '\\r'
    else escaped += character
  }
  return escaped
}

/** Quote one `ExecStart=` word so systemd passes it to the process unchanged. */
export function quoteSystemdArgument(argument: string): string {
  if (PLAIN_ARGUMENT.test(argument)) return argument
  return `"${escapeWord(argument, true)}"`
}

/** One `Environment=` assignment. systemd expands `%` there but not `$`. */
export function quoteSystemdEnvironment(name: string, value: string): string {
  return `"${name}=${escapeWord(value, false)}"`
}

const C_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', s: ' ' }

/**
 * Inverse of {@link quoteSystemdArgument}: split a stored `ExecStart=` value
 * back into arguments. Handles double and single quotes, the backslash
 * escapes the quoting emits, `%%`, and `$$`, which covers the file `install`
 * writes and ordinary hand edits.
 */
export function parseSystemdCommandLine(line: string): string[] {
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let hasToken = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    const next = line[index + 1]
    if (character === '\\' && next !== undefined) {
      current += C_ESCAPES[next] ?? next
      index += 1
      hasToken = true
    } else if ((character === '%' || character === '$') && next === character) {
      current += character
      index += 1
      hasToken = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
      hasToken = true
    } else if (/\s/.test(character)) {
      if (hasToken) argv.push(current)
      current = ''
      hasToken = false
    } else {
      current += character
      hasToken = true
    }
  }
  if (hasToken) argv.push(current)
  return argv
}

export interface UnitDefinition {
  /** Absolute Node binary, the entry script, then the server flags. */
  execStart: readonly string[]
  workingDirectory: string
  /** `PATH` for the server and the provider CLIs it spawns. */
  path: string
  description?: string
}

/**
 * The unit file. Decisions worth knowing (docs/decisions/linux-systemd-user-unit.md):
 * - `WantedBy=default.target` starts it with the user manager: at login, or at
 *   boot once linger is on.
 * - `Type=exec` makes `systemctl start` fail visibly when Node cannot be run.
 * - `PATH` is frozen from the installing shell. The user manager's own `PATH`
 *   is minimal and misses nvm, `~/.local/bin` and npm globals, where Node and
 *   the provider CLIs usually live.
 * - `KillMode=mixed` sends SIGTERM to the server alone, so it can end its
 *   provider processes itself before systemd kills whatever is left.
 * - Crash restarts are bounded: five failures in five minutes and systemd
 *   stops trying, so a broken install shows up as `failed` instead of looping.
 */
export function buildUnitFile(unit: UnitDefinition): string {
  const description = unit.description ?? UNIT_DESCRIPTION
  return [
    '# Written by "openmanager-server service install". Rerun install to change it;',
    '# keep your own additions in a drop-in: systemctl --user edit openmanager-server',
    '[Unit]',
    `Description=${escapeWord(description, false)}`,
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${unit.execStart.map(quoteSystemdArgument).join(' ')}`,
    `WorkingDirectory=${quoteSystemdArgument(unit.workingDirectory)}`,
    `Environment=${quoteSystemdEnvironment('PATH', unit.path)}`,
    'Restart=on-failure',
    'RestartSec=10',
    'KillMode=mixed',
    'TimeoutStopSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** Arguments of the unit's `ExecStart=`, or `undefined` if the file has none. */
export function readUnitExecStart(unitText: string): string[] | undefined {
  const match = /^ExecStart=(.*)$/m.exec(unitText)
  return match ? parseSystemdCommandLine(match[1]!) : undefined
}

/**
 * `PATH` for the unit: the installing shell's entries in order, with the
 * directory of the Node binary first so `#!/usr/bin/env node` provider CLIs
 * run on the same Node as the server. Duplicates and relative entries (which
 * would resolve against the data directory) are dropped.
 */
export function servicePath(shellPath: string | undefined, nodeBinary: string): string {
  const entries = [posix.dirname(nodeBinary), ...(shellPath ?? '').split(':')]
  const kept: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('/') && !kept.includes(entry)) kept.push(entry)
  }
  for (const fallback of ['/usr/local/bin', '/usr/bin', '/bin']) {
    if (!kept.includes(fallback)) kept.push(fallback)
  }
  return kept.join(':')
}

/** `systemctl show` output (`Key=Value` per line) as a record. */
export function parseSystemctlShow(output: string): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1).trim()
  }
  return properties
}

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`)

/**
 * Whether a `.wslconfig` keeps idle distros running: `[general]
 * instanceIdleTimeout` set to a negative number. WSL's default (15 s) shuts a
 * distro down once its last Windows-side process exits, whatever systemd is
 * running inside it.
 */
export function wslKeepsDistroRunning(wslconfig: string): boolean {
  let section = ''
  for (const raw of wslconfig.replace(BOM, '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = header[1]!.trim().toLowerCase()
      continue
    }
    const assignment = /^([^=]+)=(.*)$/.exec(line)
    if (section !== 'general' || !assignment) continue
    if (assignment[1]!.trim().toLowerCase() !== 'instanceidletimeout') continue
    const value = Number(assignment[2]!.trim())
    return Number.isFinite(value) && value < 0
  }
  return false
}
