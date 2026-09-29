import { spawn } from 'node:child_process'
import { createLogger, resolveLogSink } from '../logger.ts'
import { loadConfig } from '../config.ts'

export const SUPERVISOR_FLAG = '--supervise'
export const RESTART_DELAY_MS = 10_000
export const RESTART_WINDOW_MS = 300_000
export const MAX_RESTARTS = 3

/** conhost discards the child's exit code, so Windows needs a launcher that
 * observes failures itself. systemd already provides this supervision. */
export async function supervise(entry: string, args: string[]): Promise<number> {
  const config = loadConfig(args)
  const log = createLogger(config.logLevel, resolveLogSink(config.logFile))
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
      killTimer = setTimeout(() => child?.kill('SIGKILL'), 12_000)
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
        child = spawn(process.execPath, [entry, ...args], {
          // The server must outlive an abruptly terminated launcher long enough
          // to notice its parent is gone and close SQLite/provider processes.
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        })
        child.once('error', (error) => resolve({ code: 1, error }))
        child.once('exit', (code) => resolve({ code }))
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
