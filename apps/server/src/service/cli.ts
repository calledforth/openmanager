import { loadConfig, type ServerConfig } from '../config.ts'
import {
  defaultLogFile,
  resolveDeps,
  ServiceError,
  type Context,
  type ServiceBackend,
  type ServiceCommandDeps,
} from './context.ts'
import { createSystemdBackend } from './systemd.ts'
import { createWindowsBackend } from './windows.ts'

/**
 * `openmanager-server service <install|uninstall|start|stop|status>`.
 *
 * One command surface, two supervisors: a per-user logon task on Windows
 * (docs/windows-startup.md) and a systemd user unit on Linux and WSL
 * (docs/linux-systemd.md). This file owns the flow both share; the backends
 * only talk to their own supervisor.
 */

export { defaultLogFile, type RunResult, type ServiceCommandDeps } from './context.ts'

export const HEALTH_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 500

export const SERVICE_USAGE = [
  'Usage: node dist/main.js service <command> [server flags]',
  '',
  'Commands:',
  '  install [flags]  Install the background service with the given server flags and start it',
  '                   (a logon task on Windows, a systemd user unit on Linux and WSL)',
  '  uninstall        Stop the server and remove the service',
  '  start            Start the installed service now',
  '  stop             Stop the running server (the service stays installed)',
  '  status           Show the service state and whether the server answers /health',
  '',
  'Server flags for install are the normal ones (--port, --data-dir, --log-level,',
  '--allowed-origin, --allowed-host, --workspace) plus --log-file. Values are baked',
  'into the service; rerun install to change them.',
]

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

async function startAndWait(
  context: Context,
  backend: ServiceBackend,
  port: number,
  logFile: string | undefined,
): Promise<void> {
  await backend.start()
  if (await waitForHealth(context, port)) {
    context.stdout(`Environment server is up at http://127.0.0.1:${port}.`)
    return
  }
  throw new ServiceError(
    `The ${backend.kind} started but nothing answered on http://127.0.0.1:${port} within ${
      HEALTH_TIMEOUT_MS / 1000
    }s.${logFile ? ` Check ${logFile}.` : ''}`,
  )
}

async function install(context: Context, backend: ServiceBackend, flags: string[]): Promise<void> {
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

  await backend.preflight()
  const existing = await backend.read()
  if (existing) {
    context.stdout(`Replacing the existing ${backend.kind}.`)
    await backend.stop()
  }
  // Checked after the old server is gone, so a replacement cannot mistake an
  // unrelated server on the target port for its own successful start.
  if (await isHealthy(context, config.port)) {
    throw new ServiceError(
      `Something already answers on http://127.0.0.1:${config.port}. Stop it (for example a pnpm dev:web server) or pick another --port.`,
    )
  }

  await context.ensureDir(config.dataDir)
  const notes = await backend.register(config, logFile)
  context.stdout(`  Node:      ${context.execPath}`)
  context.stdout(`  Entry:     ${context.entry}`)
  context.stdout(`  Data dir:  ${config.dataDir}`)
  context.stdout(`  Log file:  ${logFile}`)
  for (const note of notes) context.stdout(note)
  await startAndWait(context, backend, config.port, logFile)
}

async function uninstall(context: Context, backend: ServiceBackend): Promise<void> {
  await backend.preflight()
  const installed = await backend.read()
  if (!installed) {
    context.stdout(`No ${backend.label} is installed; nothing to remove.`)
    return
  }
  const outcome = await backend.stop()
  await backend.remove()
  context.stdout(
    outcome === 'stopped'
      ? `Stopped the environment server and removed the ${backend.label}.`
      : `Removed the ${backend.label}; the server was not running.`,
  )
  if (installed.dataDir) {
    context.stdout(
      `Data, credentials and logs stay in ${installed.dataDir}; delete that folder to remove them.`,
    )
  }
}

async function start(context: Context, backend: ServiceBackend): Promise<void> {
  await backend.preflight()
  const installed = await backend.read()
  if (!installed) {
    throw new ServiceError(`No ${backend.label} is installed. Run "service install" first.`)
  }
  if (installed.port === undefined) {
    throw new ServiceError(
      `The installed ${backend.kind} has no --port; reinstall it with "service install".`,
    )
  }
  if (await isHealthy(context, installed.port)) {
    if (await backend.running()) {
      context.stdout(`Environment server is already up at http://127.0.0.1:${installed.port}.`)
      return
    }
    throw new ServiceError(
      `Something other than the ${backend.kind} answers on http://127.0.0.1:${installed.port}, so the service cannot start there. Stop that server (for example a pnpm dev:web server) and run "service start" again.`,
    )
  }
  await startAndWait(context, backend, installed.port, installed.logFile)
}

async function stop(context: Context, backend: ServiceBackend): Promise<void> {
  await backend.preflight()
  if (!(await backend.read())) throw new ServiceError(`No ${backend.label} is installed.`)
  const outcome = await backend.stop()
  context.stdout(
    outcome === 'stopped'
      ? `Stopped the environment server. ${backend.restartHint}`
      : 'The environment server was not running.',
  )
}

async function status(context: Context, backend: ServiceBackend): Promise<number> {
  await backend.preflight()
  const installed = await backend.read()
  if (!installed) {
    context.stdout(`Not installed: no ${backend.label}. Run "service install" to add one.`)
    return 1
  }
  for (const line of await backend.status()) context.stdout(line)
  let up = false
  if (installed.port !== undefined) {
    const healthy = await isHealthy(context, installed.port)
    up = healthy && (await backend.running())
    const answer = up
      ? 'answering /health'
      : healthy
        ? `answering /health, but not from the ${backend.kind}`
        : 'not answering'
    context.stdout(`Server:    http://127.0.0.1:${installed.port} (${answer})`)
  } else {
    context.stdout(`Server:    the ${backend.kind} has no --port; reinstall it`)
  }
  if (installed.dataDir) context.stdout(`Data dir:  ${installed.dataDir}`)
  if (installed.logFile) context.stdout(`Log file:  ${installed.logFile}`)
  return up ? 0 : 1
}

function backendFor(context: Context): ServiceBackend | undefined {
  if (context.platform === 'win32') return createWindowsBackend(context)
  if (context.platform === 'linux') return createSystemdBackend(context)
  return undefined
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
  const backend = backendFor(context)
  if (!backend) {
    context.stderr(
      `The service commands support Windows (a logon task) and Linux or WSL (a systemd user unit), not ${context.platform}.`,
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
        await install(context, backend, rest)
        return 0
      case 'uninstall':
        await uninstall(context, backend)
        return 0
      case 'start':
        await start(context, backend)
        return 0
      case 'stop':
        await stop(context, backend)
        return 0
      default:
        return await status(context, backend)
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      context.stderr(error.message)
      return 1
    }
    throw error
  }
}
