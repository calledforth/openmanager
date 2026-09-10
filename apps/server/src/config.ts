import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { AgentRuntimeOptions } from '@agentpack/runtime/node'
import type { WorkspaceRuntimeResolver } from './thread-service.ts'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface ServerConfig {
  port: number
  dataDir: string
  logLevel: LogLevel
  allowedOrigins?: readonly string[]
  /** Test-only runtime seams (fake ACP transport, fake Claude SDK, timers). */
  runtimeOptions?: AgentRuntimeOptions
  /** Test-only workspace → provider routing. Production always uses OpenCode. */
  resolveWorkspace?: WorkspaceRuntimeResolver
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
    values['allowed-origin'] ??
      env.OPENMANAGER_ALLOWED_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) ??
      [],
  )
  return {
    port: Number(port),
    dataDir: resolve(dataDir),
    logLevel: logLevel as LogLevel,
    allowedOrigins,
  }
}
