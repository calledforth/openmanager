import type { Logger } from './logger.ts'

/**
 * Security-relevant refusals, recorded so misuse can be noticed and traced to
 * a client (threat model T16). CAL-48 owns durable storage; this is the seam it
 * extends. Events never carry credentials, file contents or provider secrets.
 */
export type AuditEventType =
  | 'host.rejected'
  | 'origin.rejected'
  | 'auth.failed'
  | 'rate_limited'
  | 'workspace.rejected'
  | 'path.rejected'

export type AuditValue = string | number | boolean | null

export interface AuditEvent {
  readonly type: AuditEventType
  /** ISO-8601 time of the refusal. */
  readonly at: string
  /** The authenticated client, when the request had one. */
  readonly clientId?: string
  readonly remoteAddress?: string
  readonly details: Readonly<Record<string, AuditValue>>
}

export type AuditInput = Omit<AuditEvent, 'at'>
export type AuditListener = (event: AuditEvent) => void

/** Bound what a client-controlled string can put into a log record. */
export function auditValue(value: unknown, maxLength = 256): AuditValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const text = String(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

export function createAuditLog(log: Logger, clock: () => Date = () => new Date()) {
  const listeners = new Set<AuditListener>()
  return {
    record(input: AuditInput): AuditEvent {
      const event: AuditEvent = Object.freeze({ ...input, at: clock().toISOString() })
      log('warn', 'audit', { audit: event })
      for (const listener of listeners) listener(event)
      return event
    },
    subscribe(listener: AuditListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type AuditLog = ReturnType<typeof createAuditLog>
