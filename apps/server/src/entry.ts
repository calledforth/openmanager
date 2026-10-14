import { isSea } from 'node:sea'
import { loadConfig } from './config.ts'
import { consoleSink, createLogger, resolveLogSink, type LogSink } from './logger.ts'
import { redactSecrets } from './redact.ts'
import { runServiceCommand } from './service/cli.ts'
import { startServer } from './server.ts'
import { supervise, SUPERVISOR_FLAG } from './service/supervisor.ts'
import { runActivate, runUninstall, runUpdate } from './standalone/commands.ts'
import { serverVersion } from './standalone/version.ts'

const USAGE = [
  'Usage:',
  '  openmanager [server flags]       Run the environment server in this terminal',
  '  openmanager service <command>    Manage the background service: install, status, logs, ...',
  '                                   ("openmanager service help" lists them)',
  '  openmanager update [<version>]   Install a newer release and move the service to it',
  '  openmanager uninstall            Remove the service and this installation; keeps your data',
  '  openmanager --version            Print the version',
  '',
  'Server flags: --port, --data-dir, --log-level, --allowed-origin, --allowed-host, --workspace,',
  '--tunnel-hostname, --tunnel-token-file, --cloudflared, --log-file.',
  'Guide: https://github.com/calledforth/openmanager/blob/main/docs/install.md',
]

/** How often the server checks that the process that launched it is still alive. */
export const PARENT_WATCH_INTERVAL_MS = 2000

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function serve(): Promise<void> {
  // Startup failures must stay visible even with silent logging, and must reach
  // the log file when there is no console to see them on.
  let sink: LogSink = consoleSink
  try {
    const config = loadConfig()
    // The tunnel token is held in the config from here on. Out of the
    // environment, it is not inherited by provider CLIs, agents or terminals.
    delete process.env.OPENMANAGER_TUNNEL_TOKEN
    sink = resolveLogSink(config.logFile)
    if (sink !== consoleSink) {
      // Node prints a crash to stderr, which a service has no console for. The
      // supervisor only sees the exit code, so the reason goes to the log file.
      // A monitor records it without changing how the process ends. The line
      // skips the structured logger, so it redacts on its own (D10).
      process.on('uncaughtExceptionMonitor', (error, origin) => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
        sink(redactSecrets(`Environment server crashed (${origin}): ${detail}`), 'stderr')
      })
    }
    const log = createLogger(config.logLevel, sink)
    const server = await startServer(config)
    log('info', `Environment server listening on ${server.url}`, { pid: process.pid })
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void server
        .close()
        .catch((error: unknown) => {
          sink(error instanceof Error ? error.message : 'Server shutdown failed.', 'stderr')
          process.exitCode = 1
        })
        .finally(() => {
          if (process.connected) process.disconnect()
        })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    if (process.connected)
      process.on('message', (message) => {
        if (message === 'shutdown') stop()
      })
    if (config.exitWithParent) {
      const parent = process.ppid
      const watch = setInterval(() => {
        if (isProcessAlive(parent)) return
        clearInterval(watch)
        log('info', 'Parent process exited; stopping.', { parentPid: parent })
        stop()
      }, PARENT_WATCH_INTERVAL_MS)
      watch.unref()
    }
  } catch (error: unknown) {
    sink(redactSecrets(error instanceof Error ? error.message : 'Server startup failed.'), 'stderr')
    process.exitCode = 1
    if (process.connected) process.disconnect()
  }
}

/**
 * Run one command line. `mainPath` is the script Node was started with; the
 * released executable has none (it carries the server inside), so services it
 * installs run the executable itself.
 */
export async function run(mainPath: string): Promise<void> {
  const entry = isSea() ? undefined : mainPath
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv
  switch (command) {
    case '--version':
    case '-v':
    case 'version':
      console.log(serverVersion())
      return
    case 'help':
    case '--help':
    case '-h':
      console.log(`OpenManager environment server ${serverVersion()}\n`)
      for (const line of USAGE) console.log(line)
      return
    case 'service':
      process.exitCode = await runServiceCommand(rest, { entry })
      return
    case 'update':
      process.exitCode = await runUpdate(rest)
      return
    case 'uninstall':
      process.exitCode = await runUninstall(rest)
      return
    case 'activate':
      // Internal: the install scripts call it on the version they unpacked.
      process.exitCode = await runActivate(rest)
      return
  }
  if (argv.includes(SUPERVISOR_FLAG)) {
    try {
      process.exitCode = await supervise(
        entry,
        argv.filter((arg) => arg !== SUPERVISOR_FLAG),
      )
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Supervisor startup failed.')
      process.exitCode = 1
    } finally {
      if (process.connected) process.disconnect()
    }
    return
  }
  await serve()
}
