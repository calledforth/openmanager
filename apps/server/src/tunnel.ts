import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Logger } from './logger.ts'

/**
 * The named Cloudflare tunnel (docs/decisions/cloudflare-tunnel.md). The
 * server runs `cloudflared tunnel run` itself, watches that the connector
 * stays connected, restarts it when it dies or goes stale, and checks that
 * the public hostname really leads back to this environment.
 *
 * The two inputs, a tunnel token and its public hostname, are all a tunnel
 * needs. In v1 the owner creates them in their own Cloudflare account; later
 * managed provisioning hands over the same two, so nothing here assumes who
 * made them.
 */

/** Default token location: inside the data directory, never in a service definition. */
export const TUNNEL_TOKEN_FILE_NAME = 'tunnel-token'
/** Where the server publishes the tunnel state for `service status` and the owner. */
export const TUNNEL_STATUS_FILE_NAME = 'tunnel-status.json'
/**
 * The configuration file the connector is pointed at. Without one,
 * cloudflared reads `~/.cloudflared/config.yml` when it exists, and a
 * leftover `url:` or `loglevel:` there would apply to this tunnel too.
 */
export const CLOUDFLARED_CONFIG_FILE_NAME = 'cloudflared.yml'
// cloudflared logs an error for a file with no settings, so it holds one
// the command line already sets.
const CLOUDFLARED_CONFIG_TEXT =
  '# Written by the OpenManager environment server, which runs this tunnel.\n' +
  '# Settings come from its command line and the Cloudflare dashboard.\n' +
  'no-autoupdate: true\n'
/**
 * Where the hostname check arrives. The server sends a fresh nonce to
 * `https://<hostname>/tunnel-check?nonce=...` and the check passes only if
 * this process's own listener receives it. What comes back is not trusted:
 * `/bootstrap` and the environment ID are public, so an impostor at the
 * hostname could echo them.
 */
export const TUNNEL_CHECK_PATH = '/tunnel-check'
/** The longest token accepted. Real tokens are a few hundred characters. */
export const TUNNEL_TOKEN_MAX_LENGTH = 4096

export interface TunnelConfig {
  /** Public hostname the tunnel serves, for example `om.example.com`. */
  hostname: string
  /** Token given in `OPENMANAGER_TUNNEL_TOKEN`. Wins over the token file. */
  token?: string
  /** File holding the token. Read again before every connector start. */
  tokenFile: string
  /** Explicit `cloudflared` path. Without one, `PATH` is searched. */
  cloudflared?: string
}

/**
 * - `starting`: the connector runs but has no edge connection yet.
 * - `checking`: connected to Cloudflare; the hostname is being checked.
 * - `connected`: connected, and the hostname answered as this environment.
 * - `self_check_failed`: connected, but the hostname does not lead here (yet).
 * - `down`: the connector exited or lost every edge connection; it is being
 *   reconnected or restarted.
 * - `binary_missing`, `token_missing`: the connector cannot be started at all.
 * - `stopped`: the server is shutting down.
 */
export type TunnelState =
  | 'starting'
  | 'checking'
  | 'connected'
  | 'self_check_failed'
  | 'down'
  | 'binary_missing'
  | 'token_missing'
  | 'stopped'

/** Why the tunnel is in its state. docs/cloudflare-tunnel.md explains each. */
export type TunnelReason =
  // The connector
  | 'token_invalid'
  | 'tunnel_rejected'
  | 'token_malformed'
  | 'exited'
  | 'spawn_failed'
  | 'config_unwritable'
  | 'reconnecting'
  | 'unready'
  | 'start_timeout'
  | 'resumed_stale'
  // The hostname check
  | 'not_arrived'
  | 'tunnel_unreachable'
  | 'unreachable'
  | `http_${number}`

export interface TunnelStatus {
  state: TunnelState
  hostname: string
  /** `https://<hostname>`, only once the self-check has passed. */
  route?: string
  /** Machine-readable detail for the state, when there is one. */
  reason?: TunnelReason
  /** When the state last changed. */
  since: string
  /** Connector restarts since the server started. */
  restarts: number
  /**
   * True when the tunnel's dashboard configuration also routes other
   * hostnames or services, which the server cannot prevent. `undefined` when
   * the connector has not reported its configuration.
   */
  sharedIngress?: boolean
}

export interface TunnelTiming {
  /** Readiness probe cadence; also the tick that notices the machine slept. */
  pollMs: number
  probeTimeoutMs: number
  /** A connector that has not connected this long after starting is restarted. */
  startTimeoutMs: number
  /** A connector that lost its edge connections this long ago is restarted. */
  unreadyRestartMs: number
  /** A tick this late means the clock jumped, normally because the machine slept. */
  clockJumpMs: number
  restartMinMs: number
  restartMaxMs: number
  /** Connected this long without a crash, the restart backoff starts over. */
  stableMs: number
  selfCheckTimeoutMs: number
  selfCheckRetryMinMs: number
  selfCheckRetryMaxMs: number
  /** How often a passed self-check is repeated, in case the dashboard changed. */
  selfCheckIntervalMs: number
  /** How long a stopping connector gets before it is killed. */
  stopTimeoutMs: number
  /** At most one connector error line per this long is logged above `debug`. */
  errorLogIntervalMs: number
}

export const DEFAULT_TUNNEL_TIMING: TunnelTiming = Object.freeze({
  pollMs: 5_000,
  probeTimeoutMs: 3_000,
  startTimeoutMs: 90_000,
  unreadyRestartMs: 60_000,
  clockJumpMs: 30_000,
  restartMinMs: 1_000,
  restartMaxMs: 60_000,
  stableMs: 60_000,
  selfCheckTimeoutMs: 10_000,
  selfCheckRetryMinMs: 15_000,
  selfCheckRetryMaxMs: 300_000,
  selfCheckIntervalMs: 600_000,
  stopTimeoutMs: 5_000,
  errorLogIntervalMs: 60_000,
})

/** Failed `/ready` probes in a row before a connected connector counts as down. */
const UNREADY_PROBES = 2

type Spawn = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: true },
) => ChildProcess

/**
 * Connectors running in this process. A server that ends without stopping
 * its tunnel, through an uncaught exception, an unhandled rejection or
 * `process.exit`, ends them on its way out: a connector without its server
 * answers every device with an error instead of letting the edge say the
 * environment is unreachable. Only synchronous work runs during `exit`, and
 * a kill is synchronous.
 */
const liveConnectors = new Set<ChildProcess>()
let exitHookInstalled = false

function endConnectorsOnExit(): void {
  for (const connector of liveConnectors) connector.kill('SIGKILL')
}

function trackConnector(connector: ChildProcess): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', endConnectorsOnExit)
  }
  liveConnectors.add(connector)
  connector.once('exit', () => liveConnectors.delete(connector))
  connector.once('error', () => {
    if (connector.pid === undefined) liveConnectors.delete(connector)
  })
}

export interface TunnelSupervisorOptions {
  config: TunnelConfig
  /** The environment server's bound loopback port: the only origin the tunnel should reach. */
  port: number
  log: Logger
  /** Where to publish the status; omitted, nothing is written. */
  statusFile?: string
  /** The server-owned configuration file the connector is pointed at. */
  configFile?: string
  /** Environment the connector's own is built from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Test seams. */
  spawn?: Spawn
  fetch?: typeof fetch
  now?: () => number
  timing?: Partial<TunnelTiming>
}

/**
 * Arguments the connector runs with. The token is not among them: it goes in
 * `TUNNEL_TOKEN`, because any process on the machine can read another's
 * command line. Logging stays at `info`, because at `debug` cloudflared logs
 * request headers, and the socket credential travels in one. `--metrics` on
 * port 0 picks a free loopback port, which the connector logs and the
 * supervisor reads `/ready` from.
 */
export function cloudflaredArgs(configFile?: string): string[] {
  return [
    'tunnel',
    ...(configFile ? ['--config', configFile] : []),
    '--no-autoupdate',
    '--output',
    'json',
    '--loglevel',
    'info',
    '--metrics',
    '127.0.0.1:0',
    '--management-diagnostics=false',
    'run',
  ]
}

/** A tunnel hostname: a lowercase DNS name with at least two labels, not an IP address. */
export function validateTunnelHostname(value: string): string {
  const hostname = value.trim().toLowerCase()
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
  if (
    hostname.length <= 253 &&
    new RegExp(`^(?:${label}\\.)+${label}$`).test(hostname) &&
    /[a-z]/.test(hostname.slice(hostname.lastIndexOf('.') + 1))
  ) {
    return hostname
  }
  throw new Error(
    'Tunnel hostname must be a bare DNS name such as om.example.com: no scheme, port or path.',
  )
}

/** A token as cloudflared accepts it: one line of printable characters. */
export function validateTunnelToken(value: string): string {
  const token = value.trim()
  if (token.length === 0 || token.length > TUNNEL_TOKEN_MAX_LENGTH || /[\s\0]/.test(token)) {
    throw new Error(
      'The tunnel token must be the single-line token Cloudflare shows for the tunnel.',
    )
  }
  return token
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The `cloudflared` binary to run: the explicit path when given, else the first on `PATH`. */
export function locateCloudflared(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (explicit !== undefined) {
    if (isExecutableFile(explicit, platform)) return explicit
    // `--cloudflared C:\tools\cloudflared` names `cloudflared.exe` on Windows.
    const withExe = `${explicit}.exe`
    return platform === 'win32' && !/\.exe$/i.test(explicit) && isExecutableFile(withExe, platform)
      ? withExe
      : undefined
  }
  // Windows spells it `Path`; the lookup must not depend on the casing.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const directories = (pathKey ? env[pathKey] : undefined)?.split(delimiter) ?? []
  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  for (const directory of directories) {
    if (directory.trim().length === 0) continue
    // Absolute: a relative `PATH` entry means nothing to a service that
    // starts in another folder.
    const candidate = resolve(directory.replace(/^"(.*)"$/, '$1'), name)
    if (isExecutableFile(candidate, platform)) return candidate
  }
  return undefined
}

/**
 * The token from the environment variable, else from the token file. A file
 * that exists but holds no usable token is told apart from a missing one.
 */
export function readTunnelToken(
  config: TunnelConfig,
): { token: string } | { problem: 'missing' | 'malformed' } {
  if (config.token !== undefined) return { token: config.token }
  let text: string
  try {
    text = readFileSync(config.tokenFile, 'utf8')
  } catch {
    return { problem: 'missing' }
  }
  // A token pasted in with an editor gets the umask's 0644. The server owns
  // this file, so it narrows it to the owner before anyone else reads it.
  if (process.platform !== 'win32') {
    try {
      if ((statSync(config.tokenFile).mode & 0o077) !== 0) chmodSync(config.tokenFile, 0o600)
    } catch {
      /* A file the server cannot narrow still works; the owner chose its mode. */
    }
  }
  try {
    return { token: validateTunnelToken(text) }
  } catch {
    return { problem: 'malformed' }
  }
}

/**
 * Variables the connector may inherit: what a program needs to find its home
 * and temporary folders, reach the network through a proxy and trust its
 * certificates. Nothing else of the server's environment, which holds
 * provider keys, reaches it; no `TUNNEL_*` setting can redirect it.
 */
const CONNECTOR_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'COMPUTERNAME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Go runtime switches, such as `netedns0=0` for networks that mangle EDNS.
  'GODEBUG',
])

export function cloudflaredEnvironment(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (CONNECTOR_ENV.has(upper) || upper.startsWith('LC_') || upper.startsWith('XDG_')) {
      env[key] = value
    }
  }
  env.TUNNEL_TOKEN = token
  return env
}

const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether the connector's ingress sends anything anywhere but this server.
 * Status-code rules (the catch-all `http_status:404`) reach no origin.
 */
export function ingressIsShared(config: unknown, port: number): boolean | undefined {
  const ingress = (config as { config?: { ingress?: unknown } } | null)?.config?.ingress
  if (!Array.isArray(ingress)) return undefined
  return ingress.some((rule) => {
    const service = (rule as { service?: unknown } | null)?.service
    if (typeof service !== 'string') return true
    if (service.startsWith('http_status:')) return false
    try {
      const url = new URL(service)
      return !(
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        LOOPBACK_ORIGIN_HOSTS.has(url.hostname) &&
        Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port
      )
    } catch {
      return true
    }
  })
}

type SelfCheck = { ok: true } | { ok: false; reason: TunnelReason }

export type TunnelSupervisor = ReturnType<typeof createTunnelSupervisor>

export function createTunnelSupervisor(options: TunnelSupervisorOptions) {
  const timing: TunnelTiming = { ...DEFAULT_TUNNEL_TIMING, ...options.timing }
  const { config, log } = options
  const hostname = config.hostname
  const now = options.now ?? Date.now
  const spawn: Spawn = options.spawn ?? ((file, args, opts) => spawnProcess(file, args, opts))
  const httpFetch = options.fetch ?? fetch
  const platform = options.platform ?? process.platform

  let status: TunnelStatus = {
    state: 'starting',
    hostname,
    since: new Date(now()).toISOString(),
    restarts: 0,
  }
  const listeners = new Set<(status: TunnelStatus) => void>()

  let stopping = false
  let child: ChildProcess | undefined
  let token: string | undefined
  /** Loopback `host:port` of the running connector's metrics server. */
  let metrics: string | undefined
  let ready = false
  let everReady = false
  let failedProbes = 0
  let spawnedAt = 0
  let readySince: number | undefined
  let unreadySince: number | undefined
  /** Why the connector is down or not connecting, from its own log or exit. */
  let connectorReason: TunnelReason | undefined
  let blocked: { state: 'binary_missing' | 'token_missing'; reason?: TunnelReason } | undefined
  let selfCheck: SelfCheck | undefined
  /** The connector a self-check in flight was started for. */
  let checkingFor: ChildProcess | undefined
  let selfCheckFailures = 0
  let sharedIngress: boolean | undefined
  let crashes = 0
  let lastTick = now()
  let probing = false
  let restartReason: TunnelReason | undefined
  /**
   * When the machine last woke. The first hostname check started after it
   * decides whether the connector is stale; a check begun before it says
   * nothing about now.
   */
  let resumedAt: number | undefined
  let lastErrorLogAt = Number.NEGATIVE_INFINITY
  /** Nonces of hostname checks in flight, and whether each has arrived. */
  const pendingNonces = new Map<string, { arrived: boolean }>()

  let tick: ReturnType<typeof setInterval> | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let selfCheckTimer: ReturnType<typeof setTimeout> | undefined

  const redact = (text: string) =>
    token !== undefined && token.length > 0 ? text.split(token).join('[redacted]') : text

  function publish(next: Omit<TunnelStatus, 'since' | 'hostname' | 'restarts'>): void {
    const changed =
      next.state !== status.state || next.reason !== status.reason || next.route !== status.route
    status = {
      ...next,
      hostname,
      restarts: status.restarts,
      since: changed ? new Date(now()).toISOString() : status.since,
    }
    if (changed) {
      const healthy = ['starting', 'checking', 'connected', 'stopped'].includes(status.state)
      log(healthy ? 'info' : 'warn', `Tunnel ${status.state.replaceAll('_', ' ')}.`, {
        hostname,
        state: status.state,
        ...(status.reason ? { reason: status.reason } : {}),
      })
    }
    writeStatus()
    if (changed) for (const listener of listeners) listener(status)
  }

  let written: string | undefined
  function writeStatus(): void {
    const file = options.statusFile
    if (!file) return
    const text = `${JSON.stringify(status, null, 2)}\n`
    // Every probe refreshes the status; only a different one is written.
    if (text === written) return
    written = text
    try {
      writeFileSync(`${file}.tmp`, text)
      renameSync(`${file}.tmp`, file)
    } catch {
      // A reader holding the file open on Windows can refuse the rename.
      try {
        writeFileSync(file, text)
      } catch {
        /* The status file is a convenience; the log has the same story. */
      }
    }
  }

  /** Derive the published state from what is known about the connector. */
  function refresh(): void {
    if (stopping) return publish({ state: 'stopped' })
    const shared = sharedIngress !== undefined ? { sharedIngress } : {}
    if (blocked) {
      return publish({
        state: blocked.state,
        ...(blocked.reason ? { reason: blocked.reason } : {}),
        ...shared,
      })
    }
    if (!child) return publish({ state: 'down', reason: connectorReason ?? 'exited', ...shared })
    if (!ready) {
      return everReady
        ? publish({ state: 'down', reason: connectorReason ?? 'reconnecting', ...shared })
        : publish({
            state: 'starting',
            ...(connectorReason ? { reason: connectorReason } : {}),
            ...shared,
          })
    }
    if (selfCheck === undefined) return publish({ state: 'checking', ...shared })
    if (selfCheck.ok)
      return publish({ state: 'connected', route: `https://${hostname}`, ...shared })
    return publish({ state: 'self_check_failed', reason: selfCheck.reason, ...shared })
  }

  function backoff(): number {
    if (connectorReason === 'token_invalid') return timing.restartMaxMs
    return Math.min(timing.restartMaxMs, timing.restartMinMs * 2 ** Math.min(crashes, 16))
  }

  function scheduleStart(delay: number): void {
    clearTimeout(restartTimer)
    if (stopping) return
    restartTimer = setTimeout(startConnector, delay)
    restartTimer.unref?.()
  }

  /**
   * Write the pinned `--config`, fresh each start. `false` when it cannot be
   * written: the connector must then not start at all, because without it
   * cloudflared falls back to `~/.cloudflared/config.yml`.
   */
  function writeConnectorConfig(file: string): boolean {
    try {
      writeFileSync(file, CLOUDFLARED_CONFIG_TEXT)
      return true
    } catch (error) {
      log('warn', 'The cloudflared configuration file could not be written.', {
        file,
        reason: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function startConnector(): void {
    restartTimer = undefined
    if (stopping || child) return
    const binary = locateCloudflared(config.cloudflared, options.env ?? process.env, platform)
    const read = readTunnelToken(config)
    token = 'token' in read ? read.token : undefined
    blocked =
      binary === undefined
        ? { state: 'binary_missing' }
        : 'problem' in read
          ? {
              state: 'token_missing',
              ...(read.problem === 'malformed' ? { reason: 'token_malformed' as const } : {}),
            }
          : undefined
    if (blocked || binary === undefined || token === undefined) {
      refresh()
      // Installing the binary or saving the token later recovers without a restart.
      return scheduleStart(timing.restartMaxMs)
    }
    const configFile = options.configFile
    if (configFile !== undefined && !writeConnectorConfig(configFile)) {
      connectorReason = 'config_unwritable'
      refresh()
      return scheduleStart(timing.restartMaxMs)
    }
    metrics = undefined
    ready = false
    everReady = false
    failedProbes = 0
    readySince = undefined
    unreadySince = undefined
    connectorReason = undefined
    sharedIngress = undefined
    selfCheck = undefined
    spawnedAt = now()
    let process_: ChildProcess
    try {
      // Never `detached`. On Windows, Node puts the children it starts in a
      // job object that ends them when this process ends, however it ends, so
      // a server killed outright (Task Manager, `Stop-Process -Force`,
      // `taskkill /F`) takes its connector with it. A detached child would
      // leave that job and outlive the server.
      process_ = spawn(binary, cloudflaredArgs(configFile), {
        env: cloudflaredEnvironment(options.env ?? process.env, token),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      connectorReason = 'spawn_failed'
      log('error', 'cloudflared could not be started.', { reason: redact(String(error)) })
      crashes += 1
      refresh()
      return scheduleStart(backoff())
    }
    child = process_
    trackConnector(process_)
    log('info', 'cloudflared started.', { pid: process_.pid, binary })
    for (const stream of [process_.stdout, process_.stderr]) {
      if (!stream) continue
      createInterface({ input: stream }).on('line', (line) => onConnectorLine(line))
    }
    let gone = false
    const onGone = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (gone) return
      gone = true
      if (child === process_) child = undefined
      ready = false
      metrics = undefined
      if (stopping) return
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        blocked = { state: 'binary_missing' }
        refresh()
        return scheduleStart(timing.restartMaxMs)
      }
      const forced = restartReason
      restartReason = undefined
      if (forced) connectorReason = forced
      else if (error) connectorReason = 'spawn_failed'
      else connectorReason ??= 'exited'
      // A connector that stayed connected for a while earns a fresh backoff.
      if (readySince !== undefined && now() - readySince >= timing.stableMs) crashes = 0
      log(forced ? 'info' : 'warn', forced ? 'cloudflared restarting.' : 'cloudflared exited.', {
        code,
        signal,
        reason: connectorReason,
        ...(error ? { error: redact(error.message) } : {}),
      })
      const delay = backoff()
      crashes += 1
      status = { ...status, restarts: status.restarts + 1 }
      refresh()
      scheduleStart(delay)
    }
    process_.once('error', (error) => {
      // After a successful start, `error` means a signal could not be
      // delivered; the process lives on and `close` still reports its end.
      if (process_.pid === undefined) onGone(null, null, error)
      else log('warn', 'cloudflared could not be signalled.', { reason: redact(error.message) })
    })
    // `close`, not `exit`: the last log lines, which say why it stopped, are
    // read by then.
    process_.once('close', (code, signal) => onGone(code, signal))
    refresh()
  }

  function onConnectorLine(raw: string): void {
    const line = redact(raw)
    if (line.trim().length === 0) return
    let message = line
    let errorText = ''
    let level = ''
    try {
      const record = JSON.parse(line) as { message?: unknown; error?: unknown; level?: unknown }
      if (typeof record.message === 'string') message = record.message
      if (typeof record.error === 'string') errorText = record.error
      if (typeof record.level === 'string') level = record.level
    } catch {
      /* Not every line is JSON: argument errors are printed plainly. */
    }
    // Connector errors say why a tunnel does not come up; one a minute is
    // enough to tell, and a long outage does not flood the log.
    if (
      (level === 'error' || level === 'fatal') &&
      now() - lastErrorLogAt >= timing.errorLogIntervalMs
    ) {
      lastErrorLogAt = now()
      log('warn', 'cloudflared reported an error.', { line })
    } else {
      log('debug', 'cloudflared', { line })
    }
    const address = /Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/.exec(message)?.[1]
    if (address) {
      metrics = address
      void probe()
    } else if (message.includes('Registered tunnel connection')) {
      if (connectorReason === 'tunnel_rejected') connectorReason = undefined
      void probe()
    } else if (message.includes('Updated to new configuration')) {
      // The dashboard changed what the tunnel routes.
      if (child && metrics) void readIngress(child, metrics)
    } else if (/token is not valid/i.test(message)) {
      connectorReason = 'token_invalid'
      refresh()
    } else if (/Failed to get tunnel|Unauthorized/i.test(`${errorText} ${message}`)) {
      // The token decodes, but Cloudflare knows no such tunnel, or refuses it.
      if (connectorReason !== 'tunnel_rejected') {
        connectorReason = 'tunnel_rejected'
        refresh()
      }
    }
  }

  async function getJson(url: string, timeoutMs: number) {
    const response = await httpFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
      redirect: 'manual',
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  }

  async function probe(): Promise<void> {
    const target = child
    const address = metrics
    if (!target || !address || probing || stopping) return
    probing = true
    let isReady = false
    try {
      const { status: code, body } = await getJson(`http://${address}/ready`, timing.probeTimeoutMs)
      const connections = (body as { readyConnections?: unknown } | undefined)?.readyConnections
      isReady = code === 200 && typeof connections === 'number' && connections > 0
    } catch {
      isReady = false
    } finally {
      probing = false
    }
    if (target !== child || stopping) return
    const wasReady = ready
    if (isReady) {
      failedProbes = 0
      ready = true
      unreadySince = undefined
      if (!wasReady) {
        everReady = true
        readySince = now()
        connectorReason = undefined
        void readIngress(target, address)
        // A connector that comes back may come back to a changed dashboard.
        selfCheck = undefined
        selfCheckFailures = 0
        runSelfCheckSoon(0)
      }
    } else {
      failedProbes += 1
      // One slow answer from a busy machine is not an outage.
      if (wasReady && failedProbes < UNREADY_PROBES) return
      ready = false
      readySince = undefined
      unreadySince ??= now()
      // Whatever the wake-up check would have said, the connector says first.
      resumedAt = undefined
    }
    refresh()
  }

  async function readIngress(target: ChildProcess, address: string): Promise<void> {
    try {
      const { status: code, body } = await getJson(
        `http://${address}/config`,
        timing.probeTimeoutMs,
      )
      if (target !== child || code !== 200) return
      const shared = ingressIsShared(body, options.port)
      if (shared && sharedIngress !== true) {
        log(
          'warn',
          'The tunnel also routes other hostnames or services. Only the environment server should be behind it.',
          { hostname },
        )
      }
      sharedIngress = shared
      refresh()
    } catch {
      /* Older connectors have no /config; the field stays unknown. */
    }
  }

  function runSelfCheckSoon(delay: number): void {
    clearTimeout(selfCheckTimer)
    if (stopping) return
    selfCheckTimer = setTimeout(() => void runSelfCheck(), delay)
    selfCheckTimer.unref?.()
  }

  /**
   * A reachability-and-arrival check, not an authentication of whoever
   * answers: it passes only when the probe's single-use nonce reaches this
   * process's listener. It carries no credential. Whoever controls the zone,
   * its DNS or the tunnel's dashboard configuration could still relay the
   * hostname here and see what is later sent to it; that is the trust already
   * placed in Cloudflare and in the owner's account.
   */
  async function checkHostname(): Promise<SelfCheck> {
    const nonce = randomBytes(24).toString('base64url')
    const arrival = { arrived: false }
    pendingNonces.set(nonce, arrival)
    let code: number | undefined
    try {
      const response = await httpFetch(`https://${hostname}${TUNNEL_CHECK_PATH}?nonce=${nonce}`, {
        signal: AbortSignal.timeout(timing.selfCheckTimeoutMs),
        redirect: 'manual',
      })
      code = response.status
      await response.body?.cancel()
    } catch {
      code = undefined
    } finally {
      pendingNonces.delete(nonce)
    }
    if (arrival.arrived) return { ok: true }
    if (code === undefined) return { ok: false, reason: 'unreachable' }
    // 530 is Cloudflare's own answer: the hostname's tunnel has no connector.
    if (code === 530) return { ok: false, reason: 'tunnel_unreachable' }
    // Something answered, and it was not this server.
    if ((code >= 200 && code < 300) || code === 404) return { ok: false, reason: 'not_arrived' }
    return { ok: false, reason: `http_${code}` }
  }

  async function runSelfCheck(): Promise<void> {
    if (checkingFor !== undefined || stopping || !child || !ready) return
    const target = child
    checkingFor = target
    const startedAt = now()
    let result: SelfCheck
    try {
      result = await checkHostname()
    } finally {
      checkingFor = undefined
    }
    if (stopping) return
    // A check for a connector since replaced, or begun before the machine
    // slept, says nothing about now. The one that was skipped meanwhile runs.
    if (target !== child || (resumedAt !== undefined && startedAt < resumedAt)) {
      if (child && ready) runSelfCheckSoon(0)
      return
    }
    selfCheck = result
    const afterWake = resumedAt !== undefined
    if (result.ok || result.reason !== 'unreachable') resumedAt = undefined
    if (result.ok) {
      selfCheckFailures = 0
      runSelfCheckSoon(timing.selfCheckIntervalMs)
      // The dashboard can change what the tunnel routes at any time.
      if (metrics) void readIngress(target, metrics)
    } else {
      // A connector that says it is connected right after a sleep can hold
      // connections the edge has already dropped: Cloudflare answers 530.
      // One fresh start settles it. Anything else is retried as usual.
      if (afterWake && result.reason === 'tunnel_unreachable') {
        refresh()
        return restartConnector('resumed_stale')
      }
      selfCheckFailures += 1
      runSelfCheckSoon(
        Math.min(
          timing.selfCheckRetryMaxMs,
          timing.selfCheckRetryMinMs * 2 ** Math.min(selfCheckFailures - 1, 16),
        ),
      )
    }
    refresh()
  }

  function restartConnector(reason: TunnelReason): void {
    const running = child
    if (!running || stopping || restartReason !== undefined) return
    restartReason = reason
    running.kill()
    // cloudflared drains open requests for up to 30 s on SIGTERM; a stale
    // connector does not get that long.
    const timer = setTimeout(() => {
      if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL')
    }, timing.stopTimeoutMs)
    timer.unref?.()
  }

  function onTick(): void {
    const current = now()
    const late = current - lastTick
    lastTick = current
    if (stopping) return
    if (late >= timing.clockJumpMs) {
      log('info', 'The clock jumped; the machine probably slept. Checking the tunnel.', {
        hostname,
        sleptMs: late,
      })
      if (child) {
        // Restart deadlines counted from before the sleep; measure from now.
        spawnedAt = current
        if (!ready) unreadySince = current
        else {
          resumedAt = current
          runSelfCheckSoon(0)
        }
        void probe()
      } else {
        // A restart that was waiting out its backoff, or a missing binary or
        // token, gets an immediate retry: the network is probably back.
        scheduleStart(0)
      }
      return
    }
    if (!child) return
    void probe()
    if (!everReady && current - spawnedAt >= timing.startTimeoutMs) {
      return restartConnector(connectorReason ?? 'start_timeout')
    }
    if (everReady && !ready && unreadySince !== undefined) {
      if (current - unreadySince >= timing.unreadyRestartMs) restartConnector('unready')
    }
  }

  return {
    status(): TunnelStatus {
      return status
    },
    /**
     * Called by the listener for `GET /tunnel-check`. True, once, for the
     * nonce of a check in flight; false for anything else.
     */
    acceptArrival(nonce: string): boolean {
      const arrival = pendingNonces.get(nonce)
      if (!arrival || arrival.arrived) return false
      arrival.arrived = true
      return true
    },
    onChange(listener: (status: TunnelStatus) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(): void {
      if (tick || stopping) return
      lastTick = now()
      tick = setInterval(onTick, timing.pollMs)
      tick.unref?.()
      startConnector()
    },
    async stop(): Promise<void> {
      if (stopping) return
      stopping = true
      clearInterval(tick)
      clearTimeout(restartTimer)
      clearTimeout(selfCheckTimer)
      const running = child
      if (running && running.exitCode === null && running.signalCode === null) {
        await new Promise<void>((resolve) => {
          // A start that failed reports `error` and never `exit`; a connector
          // that will not die still lets shutdown finish.
          const done = () => {
            clearTimeout(kill)
            clearTimeout(giveUp)
            resolve()
          }
          running.once('exit', done)
          running.once('close', done)
          running.once('error', () => {
            if (running.pid === undefined) done()
          })
          running.kill()
          const kill = setTimeout(() => running.kill('SIGKILL'), timing.stopTimeoutMs)
          const giveUp = setTimeout(done, timing.stopTimeoutMs * 2)
          kill.unref?.()
          giveUp.unref?.()
        })
      }
      child = undefined
      refresh()
    },
  }
}

/** Forget a status file left by a server that ran with a tunnel and now runs without one. */
export function clearTunnelStatus(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* Nothing to forget. */
  }
}
