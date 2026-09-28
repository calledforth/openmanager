import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { ServiceError } from './context.ts'

export interface LogOptions {
  lines: number
  follow: boolean
}

export function parseLogOptions(args: readonly string[]): LogOptions {
  const options = { lines: 100, follow: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--follow' || arg === '-f') options.follow = true
    else if (arg === '--lines' || arg === '-n') {
      const value = args[++index]
      if (!value || !/^\d+$/.test(value) || Number(value) > 10000) {
        throw new ServiceError('Log line count must be an integer from 0 to 10000.')
      }
      options.lines = Number(value)
    } else throw new ServiceError(`Unknown logs option "${arg}". Use --follow or --lines N.`)
  }
  return options
}

// Bound each read and the initial tail, even if a log contains a huge single line.
const CHUNK_SIZE = 64 * 1024
const TAIL_LIMIT = 1024 * 1024

/** Follow by filename so service restart/rotation does not strand the reader on .1. */
export async function tailLogFile(
  path: string,
  options: LogOptions,
  output: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (!signal) {
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }
  const aborted = signal ?? controller.signal
  let offset = 0
  let identity: string | undefined
  let first = true
  let decoder = new StringDecoder('utf8')
  let pending = ''
  const emit = (text: string) => {
    pending += text
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      output(pending.slice(0, newline).replace(/\r$/, ''))
      pending = pending.slice(newline + 1)
    }
    if (pending.length >= CHUNK_SIZE) {
      output(pending)
      pending = ''
    }
  }
  try {
    do {
      let file
      try {
        file = await open(path, 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!options.follow) throw new ServiceError(`Log file does not exist yet: ${path}`)
      }
      if (file) {
        try {
          const stat = await file.stat()
          const current = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
          if (identity !== current || stat.size < offset) {
            if (!first) {
              emit(decoder.end())
              if (pending) output(pending)
              pending = ''
            }
            decoder = new StringDecoder('utf8')
            offset = 0
            identity = current
          }
          if (first) {
            const length = options.lines === 0 ? 0 : Math.min(stat.size, TAIL_LIMIT)
            const buffer = Buffer.alloc(length)
            const { bytesRead } = await file.read(buffer, 0, length, stat.size - length)
            let text = decoder.write(buffer.subarray(0, bytesRead))
            // Discard the potentially partial first line of a bounded tail.
            if (stat.size > length && length > 0) {
              const newline = text.indexOf('\n')
              text = newline < 0 ? '' : text.slice(newline + 1)
            }
            const lines = text.split('\n')
            if (lines.at(-1) === '') lines.pop()
            const tail = lines.slice(-options.lines)
            if (options.lines > 0) {
              for (let i = 0; i < tail.length; i++) {
                if (i === tail.length - 1 && !text.endsWith('\n') && options.follow)
                  pending = tail[i]!
                else output(tail[i]!.replace(/\r$/, ''))
              }
            }
            offset = stat.size - length + bytesRead
            first = false
          } else {
            const buffer = Buffer.alloc(CHUNK_SIZE)
            while (offset < stat.size && !aborted.aborted) {
              const { bytesRead } = await file.read(
                buffer,
                0,
                Math.min(CHUNK_SIZE, stat.size - offset),
                offset,
              )
              if (!bytesRead) break
              offset += bytesRead
              emit(decoder.write(buffer.subarray(0, bytesRead)))
            }
          }
        } finally {
          await file.close()
        }
      }
      if (!options.follow) break
      await sleep(250, undefined, { signal: aborted }).catch((error: unknown) => {
        if (!aborted.aborted) throw error
      })
    } while (!aborted.aborted)
    emit(decoder.end())
    if (pending) output(pending)
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError(
      `Cannot read log file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    if (!signal) {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  }
}
