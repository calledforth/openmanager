import { join } from 'node:path'
import { loadConfig, type ServerConfig } from '../config.ts'
import {
  locateCloudflared,
  TUNNEL_STATUS_FILE_NAME,
  validateTunnelToken,
  type TunnelStatus,
} from '../tunnel.ts'
import {
  defaultLogFile,
  resolveDeps,
  ServiceError,
  type Context,
  type ServiceBackend,
  type ServiceCommandDeps,
} from './context.ts'
import { parseLogOptions } from './logs.ts'
import { createSystemdBackend } from './systemd.ts'
import { createWindowsBackend } from './windows.ts'

/**
 * `openmanager-server service <install|uninstall|start|stop|restart|update|status|logs>`.
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
  '  restart          Stop the installed service, then start it and wait for health',
  '  update           Switch the installed service to this build, keeping its settings and data',
  '  status [--json]   Show running/stopped/failed state, health and installed paths',
  '  logs [-f] [-n N]  Print the last N log lines (default 100); --follow tails updates',
  '',
  'Server flags for install are the normal ones (--port, --data-dir, --log-level,',
  '--allowed-origin, --allowed-host, --workspace, --tunnel-hostname, --tunnel-token-file,',
  '--cloudflared) plus --log-file. Values are baked into the service; rerun install to',
  'change them. A tunnel token in OPENMANAGER_TUNNEL_TOKEN is saved to the data directory,',
  'never into the service definition.',
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
  const tunnelNotes: string[] = []
  if (config.tunnel) config = await prepareTunnel(context, config, tunnelNotes)
  const notes = [...tunnelNotes, ...(await backend.register(config, logFile))]
  context.stdout(`  Node:      ${context.execPath}`)
  context.stdout(`  Entry:     ${context.entry}`)
  context.stdout(`  Data dir:  ${config.dataDir}`)
  context.stdout(`  Log file:  ${logFile}`)
  for (const note of notes) context.stdout(note)
  await startAndWait(context, backend, config.port, logFile)
}

/**
 * Settle the tunnel inputs before anything is registered. The token goes in
 * its file in the data directory, never in the task or unit, which other
 * accounts and tools can read. The `cloudflared` found now is baked in, so the
 * service does not depend on the `PATH` its supervisor happens to provide.
 */
async function prepareTunnel(
  context: Context,
  config: ServerConfig,
  notes: string[],
): Promise<ServerConfig> {
  const tunnel = config.tunnel!
  const cloudflared = locateCloudflared(tunnel.cloudflared, context.env, context.platform)
  if (!cloudflared) {
    throw new ServiceError(
      tunnel.cloudflared
        ? `No cloudflared executable at ${tunnel.cloudflared}.`
        : 'cloudflared is not on PATH. Install it, or pass --cloudflared <path>.',
    )
  }
  if (tunnel.token !== undefined) {
    await context.writeSecretFile(tunnel.tokenFile, `${tunnel.token}\n`)
    notes.push(`  Tunnel:    token saved to ${tunnel.tokenFile}`)
  } else {
    let saved: string | undefined
    try {
      saved = validateTunnelToken((await context.readFile(tunnel.tokenFile)) ?? '')
    } catch {
      saved = undefined
    }
    if (!saved) {
      throw new ServiceError(
        `No tunnel token in ${tunnel.tokenFile}. Set OPENMANAGER_TUNNEL_TOKEN for this install, or save the token in that file.`,
      )
    }
  }
  notes.push(`  Tunnel:    https://${tunnel.hostname} through ${cloudflared}`)
  // Saved above; the service reads it from the file.
  const stored = { ...tunnel, cloudflared }
  delete stored.token
  return { ...config, tunnel: stored }
}

/** One line for `service status`: what the server last published about its tunnel. */
async function tunnelLine(
  context: Context,
  hostname: string,
  dataDir: string | undefined,
  up: boolean,
): Promise<{ line: string; status?: TunnelStatus }> {
  if (!up || !dataDir) return { line: `Tunnel:    https://${hostname} (unknown; server not up)` }
  let status: TunnelStatus | undefined
  try {
    const text = await context.readFile(join(dataDir, TUNNEL_STATUS_FILE_NAME))
    status = text === undefined ? undefined : (JSON.parse(text) as TunnelStatus)
  } catch {
    status = undefined
  }
  if (!status || status.hostname !== hostname) {
    return { line: `Tunnel:    https://${hostname} (no status yet)` }
  }
  const detail = [
    status.state.replaceAll('_', ' '),
    status.reason ? `: ${status.reason.replaceAll('_', ' ')}` : '',
    ` since ${status.since}`,
    status.sharedIngress ? '; also routes other services' : '',
  ].join('')
  return { line: `Tunnel:    https://${hostname} (${detail})`, status }
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

async function update(context: Context, backend: ServiceBackend): Promise<void> {
  await backend.preflight()
  const installed = await backend.read()
  if (!installed) {
    throw new ServiceError(`No ${backend.label} is installed. Run "service install" first.`)
  }
  if (!installed.dataDir || !installed.port || installed.port > 65535) {
    throw new ServiceError(
      'The installed service needs an explicit data directory and fixed port before updating.',
    )
  }
  // Prepare first: an unsupported definition must not take a working server down.
  const apply = await backend.prepareUpdate()
  await backend.stop()
  if (await isHealthy(context, installed.port)) {
    throw new ServiceError(
      `Another server still answers on port ${installed.port}; the service definition was retained.`,
    )
  }
  await apply()
  // Do not automatically downgrade after a failed start: the new build may
  // already have migrated SQLite. Keep the registration and data for a retry.
  await startAndWait(context, backend, installed.port, installed.logFile)
  context.stdout(
    `Updated to ${context.entry}. Identity, credentials and SQLite stay in ${installed.dataDir}.`,
  )
}

async function start(context: Context, backend: ServiceBackend, restart = false): Promise<void> {
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
  if (restart) await backend.stop()
  if (await isHealthy(context, installed.port)) {
    // For an ordinary start, only a definite "not running" blames another
    // server; an unanswered lookup still trusts /health. After a restart has
    // stopped the service, anything still answering cannot be the service.
    if (!restart && (await backend.running()) !== false) {
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

async function status(context: Context, backend: ServiceBackend, json: boolean): Promise<number> {
  await backend.preflight()
  const installed = await backend.read()
  if (!installed) {
    context.stdout(
      json
        ? JSON.stringify({ installed: false, state: 'not-installed', healthy: false })
        : `Not installed: no ${backend.label}. Run "service install" to add one.`,
    )
    return 1
  }
  const snapshot = await backend.status()
  const lines = [...snapshot.lines]
  let up = false
  if (installed.port !== undefined) {
    const healthy = await isHealthy(context, installed.port)
    const running = healthy ? await backend.running() : false
    up = healthy && running !== false
    const answer = !healthy
      ? 'not answering'
      : running === false
        ? `answering /health, but not from the ${backend.kind}`
        : running === undefined
          ? `answering /health; could not confirm it is the ${backend.kind}'s server`
          : 'answering /health'
    lines.push(`Server:    http://127.0.0.1:${installed.port} (${answer})`)
  } else {
    lines.push(`Server:    the ${backend.kind} has no --port; reinstall it`)
  }
  let tunnel: TunnelStatus | undefined
  if (installed.tunnelHostname) {
    const reported = await tunnelLine(context, installed.tunnelHostname, installed.dataDir, up)
    lines.push(reported.line)
    tunnel = reported.status
  }
  if (installed.dataDir) lines.push(`Data dir:  ${installed.dataDir}`)
  if (installed.logFile) lines.push(`Log file:  ${installed.logFile}`)
  if (json) {
    context.stdout(
      JSON.stringify({
        installed: true,
        state: snapshot.state,
        healthy: up,
        ...installed,
        ...(tunnel ? { tunnel } : {}),
      }),
    )
  } else {
    for (const line of lines) context.stdout(line)
    context.stdout(`State:     ${snapshot.state}`)
  }
  return up && snapshot.state === 'running' ? 0 : 1
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
  const known = ['install', 'uninstall', 'start', 'stop', 'restart', 'update', 'status', 'logs']
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
  if (
    command !== 'install' &&
    command !== 'logs' &&
    !(command === 'status' && rest.length === 1 && rest[0] === '--json') &&
    rest.length > 0
  ) {
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
      case 'update':
        await update(context, backend)
        return 0
      case 'start':
        await start(context, backend)
        return 0
      case 'restart':
        await start(context, backend, true)
        return 0
      case 'logs': {
        const options = parseLogOptions(rest)
        await backend.preflight()
        const installed = await backend.read()
        if (!installed) throw new ServiceError(`No ${backend.label} is installed.`)
        const path =
          installed.logFile ?? (installed.dataDir ? defaultLogFile(installed.dataDir) : undefined)
        if (!path)
          throw new ServiceError('The installed service has no log location; reinstall it.')
        context.stderr(`Log file: ${path}`)
        await context.tailLogs(path, options, context.stdout)
        return 0
      }
      case 'stop':
        await stop(context, backend)
        return 0
      default:
        return await status(context, backend, rest[0] === '--json')
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      context.stderr(error.message)
      return 1
    }
    throw error
  }
}
