/**
 * What `openmanager update --status-file <file>` writes while it runs, for the
 * server that started it (and the one that replaces it) to read back. See
 * server-update.ts. The file is replaced whole on each write.
 */

export const UPDATE_STATUS_FILE = 'server-update.json'
export const UPDATE_LOG_FILE = 'server-update.log'
export const STATUS_FILE_FLAG = '--status-file'
/** Output lines kept in the record, for the error a client shows. */
export const RECORD_LOG_LINES = 30

export interface UpdateRecord {
  state: 'updating' | 'succeeded' | 'failed'
  /** The updater's process, to tell a crashed update from a running one. */
  pid: number
  fromVersion?: string
  targetVersion?: string
  /** Milliseconds since the epoch. */
  startedAt: number
  finishedAt?: number
  error?: string
  log: string[]
}

export function readUpdateRecord(text: string | undefined): UpdateRecord | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<UpdateRecord>
    if (
      (value.state !== 'updating' && value.state !== 'succeeded' && value.state !== 'failed') ||
      typeof value.pid !== 'number' ||
      typeof value.startedAt !== 'number'
    ) {
      return undefined
    }
    const string = (field: unknown) => (typeof field === 'string' ? field : undefined)
    return {
      state: value.state,
      pid: value.pid,
      startedAt: value.startedAt,
      log: Array.isArray(value.log) ? value.log.filter((line) => typeof line === 'string') : [],
      ...(string(value.fromVersion) ? { fromVersion: value.fromVersion } : {}),
      ...(string(value.targetVersion) ? { targetVersion: value.targetVersion } : {}),
      ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
      ...(string(value.error) ? { error: value.error } : {}),
    }
  } catch {
    return undefined
  }
}
