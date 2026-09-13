import { LOG_LEVELS, type LogLevel } from './config.ts'

export type LogFields = Record<string, unknown>
export type Logger = (
  severity: Exclude<LogLevel, 'silent'>,
  message: string,
  fields?: LogFields,
) => void

export function createLogger(level: LogLevel): Logger {
  return (severity, message, fields) => {
    if (LOG_LEVELS.indexOf(severity) < LOG_LEVELS.indexOf(level)) return
    const record = JSON.stringify({ level: severity, message, ...fields })
    if (severity === 'error' || severity === 'warn') console.error(record)
    else console.log(record)
  }
}
