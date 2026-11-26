import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import {
  SERVER_UPDATE_PATH,
  ServerUpdateRequestSchema,
  type ServerUpdateStatus,
} from '@openmanager/protocol/node'
import type { AccessCapability } from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'
import type { RateLimiter } from './rate-limit.ts'
import { installedCopy } from './standalone/layout.ts'
import {
  compareVersions,
  fetchNewestRelease,
  REPOSITORY,
  releaseTag,
  releaseTarget,
} from './standalone/release.ts'
import {
  UPDATE_STATUS_FILE,
  UPDATE_LOG_FILE,
  STATUS_FILE_FLAG,
  readUpdateRecord,
  type UpdateRecord,
} from './standalone/update-record.ts'

/**
 * Updating this server from a client (protocol/server-update.ts).
 *
 * The server does not update itself. It starts `openmanager update` — the
 * same command a person runs — as a process of its own that outlives this
 * one: the update stops this server, moves the background service to the new
 * version, and starts that. The updater writes where it is to
 * `<data-dir>/server-update.json`; this server, and the one that replaces it,
 * read that file to answer `GET /server-update`.
 *
 * Releases are checked on GitHub once shortly after start and then every six
 * hours, and whenever a client asks (`?check=1`, at most every ten seconds).
 * Automatic checks only run where an update could be installed: a checkout
 * would show an update nobody can apply from a client.
 */

export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const FIRST_CHECK_DELAY_MS = 15_000
export const MANUAL_CHECK_MIN_INTERVAL_MS = 10_000

/** How the updater is started, per platform; replaced in tests. */
export type LaunchUpdater = (args: {
  executable: string
  args: string[]
  logFile: string
}) => Promise<void>

export interface ServerUpdateOptions {
  dataDir: string
  version: string
  /** This executable. */
  execPath: string
  /** Whether this process is the released single executable. */
  standalone: boolean
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  now?: () => number
  launch?: LaunchUpdater
  /** Whether automatic checks run; defaults to whether an update could be installed. */
  autoCheck?: boolean
  authenticate: (
    credential: string | undefined,
  ) => { clientId: string; capabilities: readonly AccessCapability[] } | undefined
  audit: AuditLog
  rateLimiter: RateLimiter
  budgetKey: (request: IncomingMessage) => string
  log: (
    level: 'info' | 'warn' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void
}

export interface ServerUpdateService {
  status(): Promise<ServerUpdateStatus>
  check(): Promise<void>
  start(version?: string, clientId?: string): Promise<ServerUpdateStatus>
  handle(request: IncomingMessage, response: ServerResponse): boolean
  close(): void
}

class UpdateRefused extends Error {
  readonly status: number
  readonly code: 'validation' | 'conflict' | 'unavailable'
  constructor(status: number, code: UpdateRefused['code'], message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Why this server cannot replace itself, or undefined when it can. */
function cannotUpdateReason(options: ServerUpdateOptions): string | undefined {
  if (!releaseTarget(options.platform, options.arch)) {
    return `There is no OpenManager server build for ${options.platform}-${options.arch}.`
  }
  if (!options.standalone) {
    return 'This server runs from a source checkout. Update it with git pull and a rebuild.'
  }
  if (!installedCopy(options.execPath, options.platform)) {
    return 'This server was not installed with the install script, so it cannot update itself. Reinstall it with the install script.'
  }
  return undefined
}

/**
 * Start the updater so that stopping this server cannot stop it too.
 *
 * - Under systemd, a child stays in the service's control group and
 *   `systemctl stop` kills the whole group. `systemd-run --user` starts it as
 *   a unit of its own.
 * - On Windows, `service stop` ends the server's process tree. PowerShell's
 *   `Start-Process` gives the updater a parent that exits at once, so it
 *   belongs to no tree. A detached powershell.exe gets no console and never
 *   starts; a detached cmd.exe that starts it does (as `uninstall` does).
 * - Otherwise (a server started by hand) a detached process in its own
 *   session, so closing the terminal does not end it either.
 */
export function defaultLauncher(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): LaunchUpdater {
  return async ({ executable, args, logFile }) => {
    await mkdir(dirname(logFile), { recursive: true })
    if (platform === 'win32') {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
      const script = [
        `$arguments = @(${args.map(quote).join(', ')})`,
        `Start-Process -FilePath ${quote(executable)} -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput ${quote(logFile)} -RedirectStandardError ${quote(`${logFile}.err`)}`,
      ].join('\n')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      await exited(
        spawn(
          'cmd.exe',
          [
            '/d',
            '/c',
            `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
          ],
          { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
        ),
        'PowerShell could not start the updater',
      )
      return
    }
    if (platform === 'linux' && env.INVOCATION_ID) {
      // Only the settings an update reads; the user manager supplies the rest.
      const pass = [
        'OPENMANAGER_INSTALL_DIR',
        'OPENMANAGER_BIN_DIR',
        'OPENMANAGER_RELEASES_API',
        'OPENMANAGER_RELEASE_BASE_URL',
        'XDG_DATA_HOME',
      ].flatMap((name) => (env[name] ? [`--setenv=${name}=${env[name]}`] : []))
      await exited(
        spawn(
          'systemd-run',
          [
            '--user',
            '--collect',
            '--quiet',
            `--unit=openmanager-update-${Date.now()}`,
            '--description=OpenManager server update',
            `--property=StandardOutput=append:${logFile}`,
            `--property=StandardError=append:${logFile}`,
            ...pass,
            '--',
            executable,
            ...args,
          ],
          { stdio: 'ignore' },
        ),
        'systemd-run could not start the updater',
      )
      return
    }
    const output = openSync(logFile, 'a')
    try {
      const child = spawn(executable, args, {
        detached: true,
        stdio: ['ignore', output, output],
        windowsHide: true,
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
    } finally {
      closeSync(output)
    }
  }
}

function exited(child: ReturnType<typeof spawn>, failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`${failure}: ${error.message}`)))
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${failure} (exit ${code}).`)),
    )
  })
}

export function createServerUpdateService(options: ServerUpdateOptions): ServerUpdateService {
  const now = options.now ?? Date.now
  const statusFile = join(options.dataDir, UPDATE_STATUS_FILE)
  const logFile = join(options.dataDir, 'logs', UPDATE_LOG_FILE)
  const blocked = cannotUpdateReason(options)
  const launch = options.launch ?? defaultLauncher(options.platform, options.env)
  let latest: string | undefined
  let checkedAt: number | undefined
  let checkError: string | undefined
  let checking: Promise<void> | undefined
  /** Set between launching the updater and its first write to the status file. */
  let launching: { target: string; startedAt: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  async function check(): Promise<void> {
    checking ??= (async () => {
      try {
        latest = await fetchNewestRelease(options.fetch, options.env)
        checkError = undefined
      } catch (error) {
        checkError = error instanceof Error ? error.message : String(error)
        options.log('warn', 'server release check failed', { reason: checkError })
      } finally {
        checkedAt = now()
        checking = undefined
      }
    })()
    return checking
  }

  function schedule(delay: number) {
    if (closed) return
    timer = setTimeout(() => {
      void check().finally(() => schedule(CHECK_INTERVAL_MS))
    }, delay)
    timer.unref()
  }
  if (options.autoCheck ?? blocked === undefined) schedule(FIRST_CHECK_DELAY_MS)

  async function record(): Promise<UpdateRecord | undefined> {
    return readUpdateRecord(await readFile(statusFile, 'utf8').catch(() => undefined))
  }

  async function status(): Promise<ServerUpdateStatus> {
    const current = options.version
    const found = await record()
    const iso = (time: number | undefined) =>
      time === undefined ? undefined : new Date(time).toISOString()
    const base: ServerUpdateStatus = {
      currentVersion: current,
      latestVersion: latest ?? null,
      updateAvailable: latest !== undefined && compareVersions(latest, current) > 0,
      checkedAt: iso(checkedAt) ?? null,
      ...(checkError ? { checkError } : {}),
      canUpdate: blocked === undefined,
      ...(blocked ? { cannotUpdateReason: blocked } : {}),
      state: 'idle',
      ...(latest
        ? { releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${releaseTag(latest)}` }
        : {}),
    }
    if (found && found.startedAt > (launching?.startedAt ?? 0)) launching = undefined
    if (launching) {
      if (now() - launching.startedAt < 60_000) {
        return {
          ...base,
          state: 'updating',
          targetVersion: launching.target,
          startedAt: iso(launching.startedAt),
        }
      }
      const target = launching.target
      launching = undefined
      return {
        ...base,
        state: 'failed',
        targetVersion: target,
        error: `The updater did not start. See ${logFile}.`,
      }
    }
    if (!found) return base
    const attempt = {
      ...(found.targetVersion ? { targetVersion: found.targetVersion } : {}),
      startedAt: iso(found.startedAt),
      ...(found.finishedAt ? { finishedAt: iso(found.finishedAt) } : {}),
    }
    if (found.state === 'updating') {
      if (processAlive(found.pid)) return { ...base, ...attempt, state: 'updating' }
      return {
        ...base,
        ...attempt,
        state: 'failed',
        error: `The updater stopped before it finished. See ${logFile}.`,
      }
    }
    if (found.state === 'failed') {
      // A later version running means a later attempt (or a person) fixed it.
      if (found.targetVersion && compareVersions(current, found.targetVersion) >= 0) return base
      return { ...base, ...attempt, state: 'failed', error: found.error ?? 'The update failed.' }
    }
    // Succeeded.
    if (found.targetVersion && compareVersions(current, found.targetVersion) < 0) {
      return { ...base, ...attempt, state: 'restart_required' }
    }
    return found.targetVersion === current && found.fromVersion && found.fromVersion !== current
      ? { ...base, ...attempt, updatedFrom: found.fromVersion }
      : base
  }

  async function start(version?: string, clientId?: string): Promise<ServerUpdateStatus> {
    if (blocked) throw new UpdateRefused(409, 'unavailable', blocked)
    const current = await status()
    if (current.state === 'updating') {
      throw new UpdateRefused(409, 'conflict', 'An update is already running.')
    }
    let target = version
    if (!target) {
      await check()
      if (!latest) {
        throw new UpdateRefused(
          503,
          'unavailable',
          `Could not find the newest release${checkError ? `: ${checkError}` : '.'}`,
        )
      }
      if (compareVersions(latest, options.version) <= 0) {
        throw new UpdateRefused(
          409,
          'conflict',
          `${options.version} is already the newest version.`,
        )
      }
      target = latest
    }
    if (target === options.version) {
      throw new UpdateRefused(409, 'conflict', `${target} is already running.`)
    }
    launching = { target, startedAt: now() }
    options.log('info', 'starting server update', {
      from: options.version,
      to: target,
      clientId,
    })
    try {
      await launch({
        executable: options.execPath,
        args: ['update', STATUS_FILE_FLAG, statusFile, target],
        logFile,
      })
    } catch (error) {
      launching = undefined
      const reason = error instanceof Error ? error.message : String(error)
      options.log('error', 'server update did not start', { reason })
      throw new UpdateRefused(500, 'unavailable', reason)
    }
    return status()
  }

  function respond(response: ServerResponse, code: number, body: unknown) {
    response.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }

  function error(response: ServerResponse, code: number, kind: string, message: string) {
    respond(response, code, { type: 'error', requestId: null, error: { code: kind, message } })
  }

  async function readBody(request: IncomingMessage): Promise<unknown> {
    let text = ''
    for await (const chunk of request) {
      text += String(chunk)
      if (text.length > 4096) throw new UpdateRefused(413, 'validation', 'Body too large.')
    }
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new UpdateRefused(400, 'validation', 'The body must be JSON.')
    }
  }

  function handle(request: IncomingMessage, response: ServerResponse): boolean {
    const [path, query = ''] = (request.url ?? '').split('?')
    if (path !== SERVER_UPDATE_PATH) return false
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      })
      response.end()
      return true
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.setHeader('allow', 'GET, POST')
      error(response, 405, 'validation', 'Use GET or POST.')
      return true
    }
    const command = `${request.method} ${SERVER_UPDATE_PATH}`
    const remoteAddress = request.socket.remoteAddress ?? 'unknown'
    const budget = options.budgetKey(request)
    const lockout = options.rateLimiter.blocked('auth_failure', budget)
    if (!lockout.allowed) {
      options.audit.record({
        type: 'rate_limited',
        remoteAddress,
        command,
        details: { policy: 'auth_failure', retryAfterMs: lockout.retryAfterMs },
      })
      response.setHeader('retry-after', String(Math.ceil(lockout.retryAfterMs / 1000)))
      error(response, 429, 'unavailable', 'Too many failed credential attempts.')
      return true
    }
    const client = options.authenticate(
      /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1],
    )
    if (!client) {
      options.rateLimiter.consume('auth_failure', budget)
      options.audit.record({
        type: 'auth.failed',
        remoteAddress,
        command,
        details: {
          presented: request.headers.authorization !== undefined,
          origin: auditValue(request.headers.origin),
        },
      })
      error(response, 401, 'auth', 'A valid client credential is required.')
      return true
    }
    const required: AccessCapability = request.method === 'POST' ? 'admin' : 'read'
    if (!client.capabilities.includes(required)) {
      options.audit.record({
        type: 'capability.denied',
        clientId: client.clientId,
        remoteAddress,
        command,
        details: { requiredCapability: required },
      })
      error(
        response,
        403,
        'capability_missing',
        `Updating the server needs the ${required} permission.`,
      )
      return true
    }
    void (async () => {
      try {
        if (request.method === 'GET') {
          const wantsCheck = new URLSearchParams(query).get('check') === '1'
          if (
            wantsCheck &&
            (checkedAt === undefined || now() - checkedAt >= MANUAL_CHECK_MIN_INTERVAL_MS)
          ) {
            await check()
          }
          respond(response, 200, await status())
          return
        }
        const parsed = ServerUpdateRequestSchema.safeParse(await readBody(request))
        if (!parsed.success) {
          throw new UpdateRefused(400, 'validation', 'Expected { "version": "x.y.z" } or {}.')
        }
        const started = await start(parsed.data.version, client.clientId)
        respond(response, 202, started)
      } catch (failure) {
        if (failure instanceof UpdateRefused) {
          error(response, failure.status, failure.code, failure.message)
          return
        }
        options.log('error', 'server update route failed', { reason: String(failure) })
        error(response, 500, 'unavailable', 'The update status could not be read.')
      }
    })()
    return true
  }

  return {
    status,
    check,
    start,
    handle,
    close() {
      closed = true
      clearTimeout(timer)
    },
  }
}
