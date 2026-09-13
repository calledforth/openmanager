import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openEnvironmentDatabase } from './db/database.ts'
import {
  AUDIT_EVENTS_FOR_CLIENT_SQL,
  AUDIT_EVENTS_FOR_TYPE_SQL,
  AUDIT_EVENTS_RECENT_SQL,
} from './db/queries.ts'
import type { Logger } from './logger.ts'
import { redactSecrets } from './redact.ts'

/**
 * Security-relevant events, recorded so misuse can be noticed and traced to
 * a client (threat model T16). Durable rows live in `audit_events`. Events
 * never carry credentials, file contents or provider secrets.
 */
export const AUDIT_EVENT_TYPES = [
  'host.rejected',
  'origin.rejected',
  'auth.failed',
  'rate_limited',
  'workspace.rejected',
  'path.rejected',
  'capability.denied',
  'token.issued',
  'token.revoked',
  'pairing.issued',
  'pairing.exchanged',
  'pairing.rejected',
  'upload.rejected',
] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export const AUDIT_OUTCOMES = [
  'rejected',
  'denied',
  'failed',
  'issued',
  'revoked',
  'exchanged',
] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

export const DEFAULT_AUDIT_OUTCOME = Object.freeze({
  'host.rejected': 'rejected',
  'origin.rejected': 'rejected',
  'auth.failed': 'failed',
  rate_limited: 'rejected',
  'workspace.rejected': 'rejected',
  'path.rejected': 'rejected',
  'capability.denied': 'denied',
  'token.issued': 'issued',
  'token.revoked': 'revoked',
  'pairing.issued': 'issued',
  'pairing.exchanged': 'exchanged',
  'pairing.rejected': 'rejected',
  'upload.rejected': 'rejected',
} as const satisfies Record<AuditEventType, AuditOutcome>)

export const AUDIT_QUERY_DEFAULT_LIMIT = 100
export const AUDIT_QUERY_MAX_LIMIT = 1000

export type AuditValue = string | number | boolean | null

export interface AuditEvent {
  readonly type: AuditEventType
  /** ISO-8601 time of the event. */
  readonly at: string
  /** The authenticated or named client, when the request had one. */
  readonly clientId?: string
  /** Protocol command or HTTP surface that produced the event. */
  readonly command?: string
  readonly outcome: AuditOutcome
  readonly remoteAddress?: string
  readonly details: Readonly<Record<string, AuditValue>>
}

export interface StoredAuditEvent extends AuditEvent {
  readonly eventId: string
}

export type AuditInput = Omit<AuditEvent, 'at' | 'outcome' | 'command'> & {
  command?: string
  outcome?: AuditOutcome
}

export type AuditQuery = {
  clientId?: string
  type?: AuditEventType
  outcome?: AuditOutcome
  since?: string
  until?: string
  limit?: number
}

export type AuditListener = (event: AuditEvent) => void

export interface AuditLogOptions {
  clock?: () => Date
  /** Persist and query through `openmanager.sqlite` in this data directory. */
  dataDir?: string
}

/** Bound what a client-controlled string can put into a log record. */
export function auditValue(value: unknown, maxLength = 256): AuditValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const text = String(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function liftCommand(input: AuditInput): string | undefined {
  if (typeof input.command === 'string' && input.command.length > 0) return input.command
  const fromDetails = input.details.command
  return typeof fromDetails === 'string' && fromDetails.length > 0 ? fromDetails : undefined
}

function matchesQuery(event: StoredAuditEvent, query: AuditQuery): boolean {
  if (query.clientId !== undefined && event.clientId !== query.clientId) return false
  if (query.type !== undefined && event.type !== query.type) return false
  if (query.outcome !== undefined && event.outcome !== query.outcome) return false
  if (query.since !== undefined && event.at < query.since) return false
  if (query.until !== undefined && event.at > query.until) return false
  return true
}

type AuditRow = {
  event_id: string
  type: AuditEventType
  outcome: AuditOutcome
  at: number
  client_id: string | null
  command: string | null
  remote_address: string | null
  details_json: string
}

function rowToEvent(row: AuditRow): StoredAuditEvent {
  return Object.freeze({
    eventId: row.event_id,
    type: row.type,
    outcome: row.outcome,
    at: new Date(row.at).toISOString(),
    ...(row.client_id ? { clientId: row.client_id } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.remote_address ? { remoteAddress: row.remote_address } : {}),
    details: Object.freeze(JSON.parse(row.details_json) as Record<string, AuditValue>),
  })
}

function queryPersisted(database: DatabaseSync, query: AuditQuery): StoredAuditEvent[] {
  const limit = Math.min(
    Math.max(1, query.limit ?? AUDIT_QUERY_DEFAULT_LIMIT),
    AUDIT_QUERY_MAX_LIMIT,
  )
  const cursorAt = Number.MAX_SAFE_INTEGER
  const cursorId = ''
  const rows = (
    query.clientId !== undefined
      ? database.prepare(AUDIT_EVENTS_FOR_CLIENT_SQL).all(query.clientId, cursorAt, cursorId, limit)
      : query.type !== undefined
        ? database.prepare(AUDIT_EVENTS_FOR_TYPE_SQL).all(query.type, cursorAt, cursorId, limit)
        : database.prepare(AUDIT_EVENTS_RECENT_SQL).all(cursorAt, cursorId, limit)
  ) as AuditRow[]
  return rows.map(rowToEvent).filter((event) => matchesQuery(event, query))
}

export function createAuditLog(
  log: Logger,
  clockOrOptions: (() => Date) | AuditLogOptions = {},
) {
  const options: AuditLogOptions =
    typeof clockOrOptions === 'function' ? { clock: clockOrOptions } : clockOrOptions
  const clock = options.clock ?? (() => new Date())
  const listeners = new Set<AuditListener>()
  const memory: StoredAuditEvent[] = []
  const database = options.dataDir ? openEnvironmentDatabase(options.dataDir) : undefined
  const insert = database?.prepare(`
    INSERT INTO audit_events (
      event_id, type, outcome, at, client_id, command, remote_address, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  return {
    record(input: AuditInput): AuditEvent {
      const details = Object.freeze(
        redactSecrets(input.details) as Record<string, AuditValue>,
      )
      const event: StoredAuditEvent = Object.freeze({
        eventId: randomUUID(),
        type: input.type,
        at: clock().toISOString(),
        outcome: input.outcome ?? DEFAULT_AUDIT_OUTCOME[input.type],
        ...(input.clientId ? { clientId: input.clientId } : {}),
        ...(liftCommand({ ...input, details }) ? { command: liftCommand({ ...input, details }) } : {}),
        ...(input.remoteAddress ? { remoteAddress: input.remoteAddress } : {}),
        details,
      })
      const published: AuditEvent = Object.freeze({
        type: event.type,
        at: event.at,
        outcome: event.outcome,
        ...(event.clientId ? { clientId: event.clientId } : {}),
        ...(event.command ? { command: event.command } : {}),
        ...(event.remoteAddress ? { remoteAddress: event.remoteAddress } : {}),
        details: event.details,
      })
      const severity =
        event.outcome === 'rejected' || event.outcome === 'denied' || event.outcome === 'failed'
          ? 'warn'
          : 'info'
      log(severity, 'audit', { audit: published })
      memory.push(event)
      try {
        insert?.run(
          event.eventId,
          event.type,
          event.outcome,
          Date.parse(event.at),
          event.clientId ?? null,
          event.command ?? null,
          event.remoteAddress ?? null,
          JSON.stringify(event.details),
        )
      } catch (error) {
        log('error', 'audit persist failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        })
      }
      for (const listener of listeners) listener(published)
      return published
    },
    query(query: AuditQuery = {}): StoredAuditEvent[] {
      if (database) return queryPersisted(database, query)
      const limit = Math.min(
        Math.max(1, query.limit ?? AUDIT_QUERY_DEFAULT_LIMIT),
        AUDIT_QUERY_MAX_LIMIT,
      )
      return memory.filter((event) => matchesQuery(event, query)).reverse().slice(0, limit)
    },
    subscribe(listener: AuditListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close(): void {
      database?.close()
    },
  }
}

export type AuditLog = ReturnType<typeof createAuditLog>
