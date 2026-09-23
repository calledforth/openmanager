import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, win32 } from 'node:path'
import { loadConfig, type ServerConfig } from '../config.ts'
import {
  buildTaskXml,
  encodeTaskXml,
  flagValue,
  parseCsvRecord,
  parseTaskStatus,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  readTaskArguments,
  SERVICE_MARKER_FLAG,
  serviceArguments,
  TASK_NAME,
  type TaskStatus,
} from './windows-task.ts'

/**
 * `openmanager-server service <install|uninstall|start|stop|status>`.
 *
 * Windows only for now: the server is registered as a per-user logon task
 * (docs/windows-startup.md). Linux and WSL get a systemd user unit in
 * separate work. Every system interaction goes through `deps` so the command
 * flow is testable without Task Scheduler.
 */

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ServiceCommandDeps {
  /** Absolute path of the server entry the task should run (normally `dist/main.js`). */
  entry: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Node binary baked into the task. Defaults to the one running this command. */
  execPath?: string
  run?: (file: string, args: readonly string[]) => Promise<RunResult>
  writeTempFile?: (name: string, data: Buffer) => Promise<string>
  removeFile?: (path: string) => Promise<void>
  ensureDir?: (path: string) => Promise<void>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Clock for the health and stop deadlines; tests pair it with `sleep`. */
  now?: () => number
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export const HEALTH_TIMEOUT_MS = 20_000
export const STOP_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 500

/** Task Scheduler result codes a user is likely to see in `status`. */
const LAST_RESULT_HINTS: Record<string, string> = {
  '0': 'last run exited cleanly',
  '1': 'last run failed; see the log file',
  '267009': 'currently running',
  '267011': 'has not run yet',
  '267014': 'last run was stopped',
  '2147942402': 'program not found; reinstall after moving Node or the repository',
  '2147942667': 'working directory missing; reinstall',
}

export const SERVICE_USAGE = [
  'Usage: node dist/main.js service <command> [server flags]',
  '',
  'Commands:',
  '  install [flags]  Register the Windows logon task with the given server flags and start it',
  '  uninstall        Stop the server and remove the logon task',
  '  start            Start the registered task now',
  '  stop             Stop the running server (the task stays registered)',
  '  status           Show task state and whether the server answers /health',
  '',
  'Server flags for install are the normal ones (--port, --data-dir, --log-level,',
  '--allowed-origin, --allowed-host, --workspace) plus --log-file. Values are baked',
  'into the task; rerun install to change them.',
]

function defaultRun(file: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function defaultWriteTempFile(name: string, data: Buffer): Promise<string> {
  const path = join(tmpdir(), name)
  await writeFile(path, data)
  return path
}

interface Context extends Required<Omit<ServiceCommandDeps, 'env' | 'platform'>> {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

function resolveDeps(deps: ServiceCommandDeps): Context {
  return {
    entry: deps.entry,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    execPath: deps.execPath ?? process.execPath,
    run: deps.run ?? defaultRun,
    writeTempFile: deps.writeTempFile ?? defaultWriteTempFile,
    removeFile: deps.removeFile ?? ((path) => rm(path, { force: true })),
    ensureDir: deps.ensureDir ?? (async (path) => void (await mkdir(path, { recursive: true }))),
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    stdout: deps.stdout ?? ((line) => console.log(line)),
    stderr: deps.stderr ?? ((line) => console.error(line)),
  }
}

class ServiceError extends Error {}

function schtasks(context: Context, args: readonly string[]): Promise<RunResult> {
  return context.run('schtasks.exe', args)
}

function trimOutput(result: RunResult): string {
  return `${result.stderr}${result.stdout}`.trim().replace(/\s+/g, ' ')
}

/**
 * Registered task XML, or `undefined` when Task Scheduler has no such task.
 * Absence is decided from the full task list (which succeeds whether or not
 * our task exists) rather than from a failed `/TN` query, whose error text is
 * locale-specific and also covers permission and service failures. Those are
 * surfaced instead of being mistaken for "not installed".
 */
async function readTaskXml(context: Context): Promise<string | undefined> {
  const listing = await schtasks(context, ['/Query', '/FO', 'CSV', '/NH'])
  if (listing.code !== 0) {
    throw new ServiceError(`Task Scheduler could not be queried: ${trimOutput(listing)}`)
  }
  const registered = listing.stdout
    .split(/\r?\n/)
    .some((line) => parseCsvRecord(line.trim())[0] === TASK_NAME)
  if (!registered) return undefined
  const result = await schtasks(context, ['/Query', '/TN', TASK_NAME, '/XML'])
  if (result.code !== 0) {
    throw new ServiceError(`Task Scheduler could not read ${TASK_NAME}: ${trimOutput(result)}`)
  }
  return result.stdout
}

async function readTaskStatus(context: Context): Promise<TaskStatus | undefined> {
  const result = await schtasks(context, ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V', '/NH'])
  return result.code === 0 ? parseTaskStatus(result.stdout) : undefined
}

async function isHealthy(context: Context, port: number): Promise<boolean> {
  try {
    const response = await context.fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { status?: unknown }
    return body.status === 'ok'
  } catch {
    return false
  }
}

async function waitForHealth(context: Context, port: number): Promise<boolean> {
  const deadline = context.now() + HEALTH_TIMEOUT_MS
  while (context.now() < deadline) {
    if (await isHealthy(context, port)) return true
    await context.sleep(POLL_INTERVAL_MS)
  }
  return false
}

/**
 * PIDs of node processes started from this entry by the task. Task Scheduler
 * only knows the console host, so stopping goes through the command line: the
 * entry path plus the marker flag identify our server and nothing else.
 */
async function findServerProcesses(context: Context): Promise<number[]> {
  const needle = context.entry.replace(/'/g, "''")
  const script = [
    `$needle = '${needle}'`,
    `$marker = '${SERVICE_MARKER_FLAG}'`,
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.CommandLine.Contains($marker) } |',
    '  ForEach-Object { $_.ProcessId }',
  ].join('\n')
  const result = await context.run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ])
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
}

/**
 * Stop the running server. `/End` ends the console host; the server notices
 * its parent is gone and shuts itself down. Anything still alive after the
 * grace period is terminated outright.
 */
async function stopServer(context: Context): Promise<'stopped' | 'not_running'> {
  await schtasks(context, ['/End', '/TN', TASK_NAME])
  let pids = await findServerProcesses(context)
  if (pids.length === 0) return 'not_running'
  const deadline = context.now() + STOP_TIMEOUT_MS
  while (pids.length > 0 && context.now() < deadline) {
    await context.sleep(POLL_INTERVAL_MS)
    pids = await findServerProcesses(context)
  }
  for (const pid of pids) {
    await context.run('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
  }
  return 'stopped'
}

function currentUserId(context: Context): string {
  const { USERDOMAIN, USERNAME } = context.env
  if (USERDOMAIN && USERNAME) return `${USERDOMAIN}\\${USERNAME}`
  return userInfo().username
}

function consoleHostPath(context: Context): string {
  const root = context.env.SystemRoot ?? context.env.windir ?? 'C:\\Windows'
  // A Windows path even when the tests run elsewhere.
  return win32.join(root, 'System32', 'conhost.exe')
}

export function defaultLogFile(dataDir: string): string {
  return join(dataDir, 'logs', 'server.log')
}

interface InstalledTask {
  port: number | undefined
  dataDir: string | undefined
  logFile: string | undefined
}

function describeInstalled(taskXml: string): InstalledTask {
  const argv = parseWindowsCommandLine(readTaskArguments(taskXml) ?? '')
  const port = flagValue(argv, '--port')
  return {
    port: port !== undefined && /^\d+$/.test(port) ? Number(port) : undefined,
    dataDir: flagValue(argv, '--data-dir'),
    logFile: flagValue(argv, '--log-file'),
  }
}

async function install(context: Context, flags: string[]): Promise<void> {
  let config: ServerConfig
  try {
    config = loadConfig(flags, context.env)
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message : String(error))
  }
  if (config.port === 0) {
    throw new ServiceError('The service needs a fixed --port; port 0 cannot be discovered later.')
  }
  if (config.remintOwner) {
    throw new ServiceError(
      '--remint-owner is a one-off startup flag; run the server once by hand instead.',
    )
  }
  const logFile = config.logFile ?? defaultLogFile(config.dataDir)

  const existing = await readTaskXml(context)
  if (existing) {
    context.stdout('Replacing the existing logon task.')
    await stopServer(context)
  }
  // Checked after the old server is gone, so a replacement cannot mistake an
  // unrelated server on the target port for its own successful start.
  if (await isHealthy(context, config.port)) {
    throw new ServiceError(
      `Something already answers on http://127.0.0.1:${config.port}. Stop it (for example a pnpm dev:web server) or pick another --port.`,
    )
  }

  await context.ensureDir(config.dataDir)
  const command = consoleHostPath(context)
  const args = ['--headless', context.execPath, context.entry, ...serviceArguments(config, logFile)]
  const xml = buildTaskXml({
    userId: currentUserId(context),
    command,
    arguments: args.map(quoteWindowsArgument).join(' '),
    workingDirectory: config.dataDir,
  })
  const xmlPath = await context.writeTempFile(
    `openmanager-task-${process.pid}.xml`,
    encodeTaskXml(xml),
  )
  try {
    const created = await schtasks(context, ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'])
    if (created.code !== 0) {
      throw new ServiceError(`Task Scheduler refused the task: ${trimOutput(created)}`)
    }
  } finally {
    await context.removeFile(xmlPath)
  }
  context.stdout(`Registered logon task ${TASK_NAME} for ${currentUserId(context)}.`)
  context.stdout(`  Node:      ${context.execPath}`)
  context.stdout(`  Entry:     ${context.entry}`)
  context.stdout(`  Data dir:  ${config.dataDir}`)
  context.stdout(`  Log file:  ${logFile}`)
  await startTask(context, config.port, logFile)
}

async function startTask(context: Context, port: number, logFile: string | undefined) {
  const started = await schtasks(context, ['/Run', '/TN', TASK_NAME])
  if (started.code !== 0) {
    throw new ServiceError(`Task Scheduler could not start the task: ${trimOutput(started)}`)
  }
  if (await waitForHealth(context, port)) {
    context.stdout(`Environment server is up at http://127.0.0.1:${port}.`)
    return
  }
  throw new ServiceError(
    `The task started but nothing answered on http://127.0.0.1:${port} within ${
      HEALTH_TIMEOUT_MS / 1000
    }s.${logFile ? ` Check ${logFile}.` : ''}`,
  )
}

async function uninstall(context: Context): Promise<void> {
  const existing = await readTaskXml(context)
  if (!existing) {
    context.stdout(`No logon task ${TASK_NAME} is registered; nothing to remove.`)
    return
  }
  const outcome = await stopServer(context)
  const deleted = await schtasks(context, ['/Delete', '/TN', TASK_NAME, '/F'])
  if (deleted.code !== 0) {
    throw new ServiceError(`Task Scheduler could not delete the task: ${trimOutput(deleted)}`)
  }
  const installed = describeInstalled(existing)
  context.stdout(
    outcome === 'stopped'
      ? `Stopped the environment server and removed ${TASK_NAME}.`
      : `Removed ${TASK_NAME}; the server was not running.`,
  )
  if (installed.dataDir) {
    context.stdout(
      `Data, credentials and logs stay in ${installed.dataDir}; delete that folder to remove them.`,
    )
  }
}

async function start(context: Context): Promise<void> {
  const existing = await readTaskXml(context)
  if (!existing)
    throw new ServiceError(`No logon task ${TASK_NAME} is registered. Run "service install" first.`)
  const installed = describeInstalled(existing)
  if (installed.port === undefined) {
    throw new ServiceError(
      'The registered task has no --port; reinstall it with "service install".',
    )
  }
  if (await isHealthy(context, installed.port)) {
    context.stdout(`Environment server is already up at http://127.0.0.1:${installed.port}.`)
    return
  }
  await startTask(context, installed.port, installed.logFile)
}

async function stop(context: Context): Promise<void> {
  const existing = await readTaskXml(context)
  if (!existing) throw new ServiceError(`No logon task ${TASK_NAME} is registered.`)
  const outcome = await stopServer(context)
  context.stdout(
    outcome === 'stopped'
      ? 'Stopped the environment server. It starts again at your next sign-in or with "service start".'
      : 'The environment server was not running.',
  )
}

async function status(context: Context): Promise<number> {
  const existing = await readTaskXml(context)
  if (!existing) {
    context.stdout(`Not installed: no logon task ${TASK_NAME}. Run "service install" to add one.`)
    return 1
  }
  const installed = describeInstalled(existing)
  const taskStatus = await readTaskStatus(context)
  const state = taskStatus?.state ?? 'unknown'
  const hint = taskStatus ? LAST_RESULT_HINTS[taskStatus.lastResult] : undefined
  context.stdout(`Task:      ${TASK_NAME} (${state})`)
  if (taskStatus) {
    context.stdout(
      `Last run:  ${taskStatus.lastRunTime}, result ${taskStatus.lastResult}${hint ? ` (${hint})` : ''}`,
    )
  }
  let healthy = false
  if (installed.port !== undefined) {
    healthy = await isHealthy(context, installed.port)
    context.stdout(
      `Server:    http://127.0.0.1:${installed.port} (${healthy ? 'answering /health' : 'not answering'})`,
    )
  } else {
    context.stdout('Server:    the task has no --port; reinstall it')
  }
  if (installed.dataDir) context.stdout(`Data dir:  ${installed.dataDir}`)
  if (installed.logFile) context.stdout(`Log file:  ${installed.logFile}`)
  return healthy ? 0 : 1
}

/** Returns the process exit code. */
export async function runServiceCommand(
  args: readonly string[],
  deps: ServiceCommandDeps,
): Promise<number> {
  const context = resolveDeps(deps)
  const [command, ...rest] = args
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    for (const line of SERVICE_USAGE) context.stdout(line)
    return command === undefined ? 1 : 0
  }
  const known = ['install', 'uninstall', 'start', 'stop', 'status']
  if (!known.includes(command)) {
    context.stderr(`Unknown service command "${command}".`)
    for (const line of SERVICE_USAGE) context.stderr(line)
    return 1
  }
  if (context.platform !== 'win32') {
    context.stderr(
      'The service commands manage a Windows logon task and only run on Windows. Linux and WSL use a systemd user unit, which is separate work.',
    )
    return 1
  }
  if (command !== 'install' && rest.length > 0) {
    context.stderr(`"service ${command}" takes no arguments.`)
    return 1
  }
  try {
    switch (command) {
      case 'install':
        await install(context, rest)
        return 0
      case 'uninstall':
        await uninstall(context)
        return 0
      case 'start':
        await start(context)
        return 0
      case 'stop':
        await stop(context)
        return 0
      default:
        return await status(context)
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      context.stderr(error.message)
      return 1
    }
    throw error
  }
}
