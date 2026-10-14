import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { appendLogFile, consoleSink, createLogger, type LogSink } from '../logger.ts'
import { loadConfig } from '../config.ts'
import { redactSecrets } from '../redact.ts'

export const SUPERVISOR_FLAG = '--supervise'
export const RESTART_DELAY_MS = 10_000
export const RESTART_WINDOW_MS = 300_000
export const MAX_RESTARTS = 3
export const SHUTDOWN_TIMEOUT_MS = 15_000
/** How long a server that has exited gets to finish writing what it printed last. */
export const OUTPUT_DRAIN_MS = 2_000

/**
 * Copy what the server prints into the supervisor's sink, a line at a time.
 * The server's own log lines go straight to the log file; what arrives here is
 * whatever Node or a library printed: warnings, and the report of a crash.
 * Resolves once the stream has ended.
 */
function forwardOutput(
  stream: Readable | null | undefined,
  name: 'stdout' | 'stderr',
  sink: LogSink,
): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line.trim() !== '') sink(redactSecrets(line), name)
    })
    lines.once('close', resolve)
    stream.once('error', () => resolve())
  })
}

/** conhost discards the child's exit code, so Windows needs a launcher that
 * observes failures itself. systemd already provides this supervision. */
export async function supervise(entry: string | undefined, args: string[]): Promise<number> {
  const config = loadConfig(args)
  // By path, not a held descriptor: each server it starts may rotate the file.
  const sink = config.logFile ? appendLogFile(config.logFile) : consoleSink
  const log = createLogger(config.logLevel, sink)
  const parent = process.ppid
  const failures: number[] = []
  let stopping = false
  let child: ReturnType<typeof spawn> | undefined
  let wake: (() => void) | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (stopping) return
    stopping = true
    wake?.()
    if (child && child.exitCode === null && child.signalCode === null) {
      // Windows signals terminate abruptly; IPC reaches the normal close path.
      if (child.connected) child.send('shutdown', () => {})
      killTimer = setTimeout(() => child?.kill('SIGKILL'), SHUTDOWN_TIMEOUT_MS)
      killTimer.unref()
    }
  }
  const watch = setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch {
      stop()
    }
  }, 500)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // Also permits a supervising test/launcher to request an intentional stop.
  const onMessage = (message: unknown) => {
    if (message === 'shutdown') stop()
  }
  process.on('message', onMessage)
  try {
    while (!stopping) {
      const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child = spawn(process.execPath, entry === undefined ? args : [entry, ...args], {
          // The server must outlive an abruptly terminated launcher long enough
          // to notice its parent is gone and close SQLite/provider processes.
          detached: true,
          windowsHide: true,
          // Not 'inherit'. A detached process has no console of its own, and on
          // Windows the console handles it would inherit stop working once the
          // first program it starts has exited (measured). Every write after
          // that throws EBADF, so the first warning Node printed crashed the
          // server. A pipe works for as long as this process reads it.
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        const output = Promise.all([
          forwardOutput(child.stdout, 'stdout', sink),
          forwardOutput(child.stderr, 'stderr', sink),
        ])
        child.once('error', (error) => resolve({ code: 1, error }))
        child.once('exit', (code) => {
          // Let the last lines (a crash report) land before the crash is
          // logged. A program the server started may still hold the pipe
          // open, so the wait is bounded.
          const drain = setTimeout(() => resolve({ code }), OUTPUT_DRAIN_MS)
          void output.then(() => {
            clearTimeout(drain)
            resolve({ code })
          })
        })
      })
      clearTimeout(killTimer)
      if (stopping || result.code === 0) return 0
      const now = Date.now()
      while (failures.length && failures[0]! <= now - RESTART_WINDOW_MS) failures.shift()
      log('error', 'Environment server crashed.', {
        exitCode: result.code,
        error: result.error?.message,
      })
      if (failures.length >= MAX_RESTARTS) {
        log('error', 'Crash restart limit reached; run service start after fixing the failure.')
        return 1
      }
      failures.push(now)
      log('info', 'Restarting environment server.', {
        delayMs: RESTART_DELAY_MS,
        attempt: failures.length,
      })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, RESTART_DELAY_MS)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
        if (stopping) wake()
      })
      wake = undefined
    }
    return 0
  } finally {
    clearInterval(watch)
    clearTimeout(killTimer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    process.removeListener('message', onMessage)
  }
}
