import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { AgentRuntimeOptions } from '@agentpack/runtime/node'
import type { WorkspaceRuntimeResolver } from './thread-service.ts'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface ServerConfig {
  port: number
  dataDir: string
  logLevel: LogLevel
  /** Exact browser origins allowed to call the server. Requests with any other `Origin` fail. */
  allowedOrigins?: readonly string[]
  /**
   * `Host` header values accepted in addition to the loopback forms of the bound
   * port. A tunnel or reverse proxy hostname must be listed here.
   */
  allowedHosts?: readonly string[]
  /** Workspace roots this environment may expose. Every client path resolves under one of them. */
  workspaces?: readonly string[]
  /** Test-only runtime seams (fake ACP transport, fake Claude SDK, timers). */
  runtimeOptions?: AgentRuntimeOptions
  /** Test-only workspace → provider routing. Production resolves through the workspace registry. */
  resolveWorkspace?: WorkspaceRuntimeResolver
  /**
   * When true, startup always remints the owner credential instead of reusing
   * the published file. Explicit only: there is no environment variable for this.
   */
  remintOwner?: boolean
}

export function validateOrigins(origins: readonly string[]): string[] {
  return [
    ...new Set(
      origins.map((origin) => {
        try {
          const url = new URL(origin)
          if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin) {
            return origin
          }
        } catch {
          /* Report the same configuration error for all invalid origins. */
        }
        throw new Error(
          'Allowed origins must be exact http(s) origins without paths or credentials.',
        )
      }),
    ),
  ]
}

/**
 * An allowed host is a lowercase `host` or `host:port` as a browser or proxy
 * sends it in the `Host` header: no scheme, path, userinfo or wildcard.
 */
export function validateHosts(hosts: readonly string[]): string[] {
  return [
    ...new Set(
      hosts.map((host) => {
        const trimmed = host.trim().toLowerCase()
        try {
          const url = new URL(`http://${trimmed}`)
          if (
            /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(trimmed) &&
            url.host === trimmed &&
            url.username === '' &&
            url.password === '' &&
            url.pathname === '/' &&
            url.search === '' &&
            url.hash === ''
          ) {
            return trimmed
          }
        } catch {
          /* Report the same configuration error for all invalid hosts. */
        }
        throw new Error('Allowed hosts must be exact host or host:port values.')
      }),
    ),
  ]
}

export function validateWorkspaceRoots(roots: readonly string[]): string[] {
  return [
    ...new Set(
      roots.map((root) => {
        if (root.trim().length === 0 || root.includes('\0')) {
          throw new Error('Workspace roots must be non-empty filesystem paths.')
        }
        return resolve(root)
      }),
    ),
  ]
}

const splitList = (value: string | undefined, separator: string) =>
  value
    ?.split(separator)
    .map((item) => item.trim())
    .filter(Boolean)

export function loadConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'log-level': { type: 'string' },
      'allowed-origin': { type: 'string', multiple: true },
      'allowed-host': { type: 'string', multiple: true },
      workspace: { type: 'string', multiple: true },
      'remint-owner': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  const port = values.port ?? env.OPENMANAGER_PORT ?? '43120'
  if (!/^\d+$/.test(port) || !Number.isSafeInteger(Number(port)) || Number(port) > 65535) {
    throw new Error('Port must be an integer from 0 to 65535 (0 chooses an available port).')
  }
  const dataDir = values['data-dir'] ?? env.OPENMANAGER_DATA_DIR ?? join(homedir(), '.openmanager')
  if (dataDir.trim().length === 0 || dataDir.includes('\0')) {
    throw new Error('Data directory must be a non-empty filesystem path.')
  }
  const logLevel = values['log-level'] ?? env.OPENMANAGER_LOG_LEVEL ?? 'info'
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(`Log level must be one of: ${LOG_LEVELS.join(', ')}.`)
  }
  const allowedOrigins = validateOrigins(
    values['allowed-origin'] ?? splitList(env.OPENMANAGER_ALLOWED_ORIGINS, ',') ?? [],
  )
  const allowedHosts = validateHosts(
    values['allowed-host'] ?? splitList(env.OPENMANAGER_ALLOWED_HOSTS, ',') ?? [],
  )
  // Roots are paths, so the environment list uses the platform PATH delimiter.
  const workspaces = validateWorkspaceRoots(
    values.workspace ?? splitList(env.OPENMANAGER_WORKSPACES, delimiter) ?? [],
  )
  return {
    port: Number(port),
    dataDir: resolve(dataDir),
    logLevel: logLevel as LogLevel,
    allowedOrigins,
    allowedHosts,
    workspaces,
    remintOwner: values['remint-owner'] === true,
  }
}
