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
  // The token is never an argument: the service reads it from its file.
  if (config.tunnel) {
    args.push('--tunnel-hostname', config.tunnel.hostname)
    args.push('--tunnel-token-file', config.tunnel.tokenFile)
    if (config.tunnel.cloudflared) args.push('--cloudflared', config.tunnel.cloudflared)
  }
  args.push('--log-file', logFile)
  return args
}

/**
 * Split a stored command line into the program that runs the server and its
 * flags. The program is everything before the first `--flag`: `node` plus
 * `main.js` for a checkout, or the `openmanager` executable alone for an
 * installed release. Neither path starts with `--`, and every server flag does.
 */
export function splitProgram(argv: readonly string[]): {
  program: string[]
  flags: string[]
} {
  const index = argv.findIndex((arg) => arg.startsWith('--'))
  const end = index === -1 ? argv.length : index
  return { program: argv.slice(0, end), flags: argv.slice(end) }
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
  const tunnelHostname = flagValue(argv, '--tunnel-hostname')
  return {
    port: port !== undefined && /^\d+$/.test(port) ? Number(port) : undefined,
    dataDir: flagValue(argv, '--data-dir'),
    logFile: flagValue(argv, '--log-file'),
    ...(tunnelHostname !== undefined ? { tunnelHostname } : {}),
  }
}
