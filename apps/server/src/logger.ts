import { LOG_LEVELS, type LogLevel } from './config.ts'

export function createLogger(level: LogLevel) {
  return (severity: Exclude<LogLevel, 'silent'>, message: string): void => {
    if (LOG_LEVELS.indexOf(severity) < LOG_LEVELS.indexOf(level)) return
    const record = JSON.stringify({ level: severity, message })
    if (severity === 'error' || severity === 'warn') console.error(record)
    else console.log(record)
  }
}
