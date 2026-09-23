import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { consoleSink, createLogger, resolveLogSink, type LogSink } from './logger.ts'
import { runServiceCommand } from './service/cli.ts'
import { startServer } from './server.ts'

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
    sink = resolveLogSink(config.logFile)
    const log = createLogger(config.logLevel, sink)
    const server = await startServer(config)
    log('info', `Environment server listening on ${server.url}`)
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void server.close().catch((error: unknown) => {
        sink(error instanceof Error ? error.message : 'Server shutdown failed.', 'stderr')
        process.exitCode = 1
      })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
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
    sink(error instanceof Error ? error.message : 'Server startup failed.', 'stderr')
    process.exitCode = 1
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'service') {
  process.exitCode = await runServiceCommand(rest, { entry: fileURLToPath(import.meta.url) })
} else {
  await serve()
}
