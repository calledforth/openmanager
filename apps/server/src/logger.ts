import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { LOG_LEVELS, type LogLevel } from './config.ts'
import { redactSecrets } from './redact.ts'

export type LogFields = Record<string, unknown>
export type Logger = (
  severity: Exclude<LogLevel, 'silent'>,
  message: string,
  fields?: LogFields,
) => void

/** Where one finished log line goes. `stream` mirrors the console split. */
export type LogSink = (line: string, stream: 'stdout' | 'stderr') => void

/** A file this size or larger is rotated to `<file>.1` when it is next opened. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024

export const consoleSink: LogSink = (line, stream) => {
  if (stream === 'stderr') console.error(line)
  else console.log(line)
}

const openSinks = new Map<string, LogSink>()

/**
 * Append-only sink for a process without a console. One descriptor per path
 * per process, so the entry point and the server share a file without
 * interleaving partial lines. Rotation happens once, at open, so a long-running
 * service is bounded to roughly two files; finer retention belongs to the
 * service status/logs work.
 */
export function openLogFile(path: string): LogSink {
  const file = resolve(path)
  const existing = openSinks.get(file)
  if (existing) return existing
  mkdirSync(dirname(file), { recursive: true })
  try {
    if (statSync(file).size >= LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    /* Missing file: nothing to rotate. A failed rename keeps appending. */
  }
  const fd = openSync(file, 'a')
  const sink: LogSink = (line) => {
    try {
      writeSync(fd, `${line}\n`)
    } catch {
      /* A full or detached disk must not take the server down with it. */
    }
  }
  openSinks.set(file, sink)
  process.once('exit', () => {
    openSinks.delete(file)
    try {
      closeSync(fd)
    } catch {
      /* already closed */
    }
  })
  return sink
}

export function resolveLogSink(logFile: string | undefined): LogSink {
  return logFile ? openLogFile(logFile) : consoleSink
}

export function createLogger(level: LogLevel, sink: LogSink = consoleSink): Logger {
  return (severity, message, fields) => {
    if (LOG_LEVELS.indexOf(severity) < LOG_LEVELS.indexOf(level)) return
    const record = JSON.stringify(redactSecrets({ level: severity, message, ...fields }))
    sink(record, severity === 'error' || severity === 'warn' ? 'stderr' : 'stdout')
  }
}
