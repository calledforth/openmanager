import type { ServerConfig } from '../config.ts'
import type { InstalledService } from './context.ts'

/**
 * The server flags an installed service runs with, on every platform.
 * Everything the installing shell resolved (flags, environment variables,
 * defaults) becomes explicit, so the service does not depend on the
 * environment its supervisor happens to provide.
 */
export function serverArguments(config: ServerConfig, logFile: string): string[] {
  const args = [
    '--port',
    String(config.port),
    '--data-dir',
    config.dataDir,
    '--log-level',
    config.logLevel,
  ]
  for (const origin of config.allowedOrigins ?? []) args.push('--allowed-origin', origin)
  for (const host of config.allowedHosts ?? []) args.push('--allowed-host', host)
  for (const workspace of config.workspaces ?? []) args.push('--workspace', workspace)
  args.push('--log-file', logFile)
  return args
}

/** Value that follows `flag` in an argument list, or `undefined`. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value !== undefined && !value.startsWith('--') ? value : undefined
}

/** Port, data directory and log file of an installed service, from its stored arguments. */
export function describeArguments(argv: readonly string[]): InstalledService {
  const port = flagValue(argv, '--port')
  return {
    port: port !== undefined && /^\d+$/.test(port) ? Number(port) : undefined,
    dataDir: flagValue(argv, '--data-dir'),
    logFile: flagValue(argv, '--log-file'),
  }
}
