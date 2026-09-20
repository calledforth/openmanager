import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  UPLOAD_PATH_PREFIX,
  UPLOAD_TICKET_CAPABILITY,
  UploadCommandSchemas,
  UploadResponseSchemas,
  UploadResultSchema,
  type CommandEnvelope,
  type ErrorCode,
} from '@openmanager/protocol/node'
import { auditValue, type AuditLog, type AuditValue } from './audit.ts'
import type { AuthenticatedClient } from './authorized-clients.ts'
import type { CommandContext } from './command-context.ts'
import type { Logger } from './logger.ts'
import type { RateLimiter } from './rate-limit.ts'
import { isAllowedUploadType, isOversizedUpload, MAX_ATTACHMENT_BYTES } from './upload-limits.ts'

/** A ticket only has to outlive the gap between the command and the start of the PUT. */
export const UPLOAD_TICKET_TTL_MS = 2 * 60_000
/** A transfer that has not finished by now is cut and its partial file removed. */
export const UPLOAD_TRANSFER_TIMEOUT_MS = 5 * 60_000
export const UPLOAD_MAX_TICKETS_PER_CLIENT = 32
export const UPLOAD_MAX_TICKETS = 1024
export const UPLOAD_DIRECTORY = 'uploads'
/** Every in-flight transfer writes here, so one sweep of it finds every partial file. */
export const UPLOAD_PARTIAL_DIRECTORY = 'partial'

type Ticket = {
  clientId: string
  sessionId: string
  workspaceId: string
  name: string
  mimeType: string
  sizeBytes: number
  expiresAt: number
}

const errorResult = (requestId: string | null, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

const hashTicket = (ticket: string) => createHash('sha256').update(ticket, 'utf8').digest('hex')

/**
 * Request-scoped upload tickets (threat model T14, D9). File bytes stay off
 * the WebSocket: `upload.ticket.create` declares one file for one session and
 * answers a single-use ticket, and `PUT /uploads/<ticket>` streams the bytes to
 * environment blob storage and answers the artifact id a message references.
 *
 * The ticket is not a credential. The PUT must also present the credential of
 * the client the ticket was issued to, so a leaked ticket is useless alone and
 * revoking a client ends its outstanding tickets with it. Tickets live in
 * memory only: a restart invalidates them all, which fails safe.
 */
export function createUploadService(options: {
  dataDir: string
  database: DatabaseSync
  audit: AuditLog
  log: Logger
  rateLimiter: RateLimiter
  authenticate: (credential: string | undefined) => AuthenticatedClient | undefined
  /** The workspace that owns a session, or `undefined` when the session does not exist. */
  sessionWorkspace: (sessionId: string) => string | undefined
  /** Whether the caller may reach the workspace; a refusal is audited by the resolver. */
  resolveWorkspace: (workspaceId: string, context?: CommandContext) => unknown | undefined
  clock?: () => number
  ticketTtlMs?: number
  transferTimeoutMs?: number
}) {
  const clock = options.clock ?? (() => Date.now())
  const ticketTtlMs = options.ticketTtlMs ?? UPLOAD_TICKET_TTL_MS
  const transferTimeoutMs = options.transferTimeoutMs ?? UPLOAD_TRANSFER_TIMEOUT_MS
  const blobDirectory = join(options.dataDir, UPLOAD_DIRECTORY)
  const partialDirectory = join(blobDirectory, UPLOAD_PARTIAL_DIRECTORY)
  const tickets = new Map<string, Ticket>()
  /** In-flight transfers and the client each belongs to. */
  const transfers = new Map<(reason?: string) => void, string>()

  mkdirSync(partialDirectory, { recursive: true })
  // Nothing is in flight when the process starts, so whatever is here was cut
  // off by a crash or a kill that the per-request cleanup never got to see.
  for (const entry of readdirSync(partialDirectory)) {
    rmSync(join(partialDirectory, entry), { force: true })
  }
  // A blob is renamed into place just before its row is written. A crash in
  // between leaves a finished blob nothing names, so startup removes those too.
  const recorded = options.database.prepare(
    'SELECT 1 FROM attachments WHERE storage_key = ? LIMIT 1',
  )
  for (const entry of readdirSync(blobDirectory, { withFileTypes: true })) {
    if (entry.isFile() && !recorded.get(`${UPLOAD_DIRECTORY}/${entry.name}`)) {
      rmSync(join(blobDirectory, entry.name), { force: true })
    }
  }

  const insert = options.database.prepare(`
    INSERT INTO attachments (
      attachment_id, workspace_id, message_id, uploaded_by_client_id, storage_key,
      name, mime_type, size_bytes, metadata_json, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `)

  const pruneExpired = () => {
    const now = clock()
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key)
  }

  const reject = (
    reason: string,
    details: Record<string, AuditValue>,
    who: { clientId?: string; remoteAddress?: string; command: string },
  ) =>
    options.audit.record({
      type: 'upload.rejected',
      clientId: who.clientId,
      remoteAddress: who.remoteAddress,
      command: who.command,
      details: { reason, ...details },
    })

  const respond = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    if (response.headersSent || response.destroyed) return
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    response.end(JSON.stringify(body))
  }

  /**
   * Refuse a PUT whose body may still be arriving. The rest of it is read and
   * discarded, never kept, and `Connection: close` ends the socket after.
   */
  const refuse = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    code: ErrorCode,
    message: string,
  ) => {
    request.resume()
    respond(response, status, errorResult(null, code, message), { connection: 'close' })
  }

  const createTicket = (command: CommandEnvelope, context?: CommandContext) => {
    const parsed = UploadCommandSchemas[UPLOAD_TICKET_CAPABILITY].safeParse(command)
    if (!parsed.success || !context) {
      return errorResult(command.requestId, 'validation', 'Invalid upload request.')
    }
    const input = parsed.data.payload
    const who = { clientId: context.clientId, command: command.name }
    if (!isAllowedUploadType(input.mimeType)) {
      reject('unsupported_type', { mimeType: input.mimeType }, who)
      return errorResult(
        command.requestId,
        'validation',
        'Attachments must be PNG, JPEG or WebP images.',
      )
    }
    if (isOversizedUpload(input.sizeBytes)) {
      reject('oversized', { sizeBytes: input.sizeBytes, maxBytes: MAX_ATTACHMENT_BYTES }, who)
      return errorResult(
        command.requestId,
        'validation',
        `Attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes.`,
      )
    }
    const workspaceId = options.sessionWorkspace(input.sessionId)
    if (workspaceId === undefined || !options.resolveWorkspace(workspaceId, context)) {
      return errorResult(command.requestId, 'not_found', 'Session not found.')
    }
    pruneExpired()
    let held = 0
    for (const ticket of tickets.values()) if (ticket.clientId === context.clientId) held += 1
    if (held >= UPLOAD_MAX_TICKETS_PER_CLIENT || tickets.size >= UPLOAD_MAX_TICKETS) {
      reject('ticket_limit', { sessionId: input.sessionId }, who)
      return errorResult(command.requestId, 'unavailable', 'Too many uploads are pending.')
    }
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = clock() + ticketTtlMs
    tickets.set(hashTicket(ticket), {
      ...input,
      mimeType: input.mimeType.toLowerCase(),
      clientId: context.clientId,
      workspaceId,
      expiresAt,
    })
    return UploadResponseSchemas[UPLOAD_TICKET_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: {
        ticket,
        uploadPath: `${UPLOAD_PATH_PREFIX}${ticket}`,
        expiresAt: new Date(expiresAt).toISOString(),
        maxBytes: input.sizeBytes,
      },
    })
  }

  const receive = (
    request: IncomingMessage,
    response: ServerResponse,
    ticket: Ticket,
    who: { clientId: string; remoteAddress: string; command: string },
  ) => {
    const artifactId = randomUUID()
    // The stored name is minted here. The client's file name is display text
    // in the metadata row and never reaches the filesystem.
    const storageKey = `${UPLOAD_DIRECTORY}/${artifactId}`
    const partialPath = join(partialDirectory, artifactId)
    const finalPath = join(blobDirectory, artifactId)
    const file = createWriteStream(partialPath, { flags: 'wx' })
    let received = 0
    let written = false
    let settled = false

    const settle = () => {
      if (settled) return false
      settled = true
      clearTimeout(deadline)
      transfers.delete(cut)
      return true
    }
    // Windows refuses to unlink an open file, so a partial file is only
    // removed once its descriptor has closed; the `close` handler does it.
    const abandon = () => {
      if (!settle()) return false
      request.unpipe(file)
      if (file.closed) rmSync(partialPath, { force: true })
      else file.destroy()
      return true
    }
    const fail = (reason: string, status: number, code: ErrorCode, message: string) => {
      if (!abandon()) return
      reject(reason, { sessionId: ticket.sessionId, receivedBytes: received }, who)
      refuse(request, response, status, code, message)
    }
    // Shutdown cuts silently; a revocation is recorded against the client.
    const cut = (reason?: string) => {
      if (!abandon()) return
      if (reason) reject(reason, { sessionId: ticket.sessionId, receivedBytes: received }, who)
      request.destroy()
    }
    const deadline = setTimeout(
      () => fail('timeout', 408, 'unavailable', 'The upload took too long.'),
      transferTimeoutMs,
    )
    deadline.unref()
    transfers.set(cut, ticket.clientId)

    const complete = () => {
      if (received !== ticket.sizeBytes) {
        fail('size_mismatch', 400, 'validation', 'The upload does not match the declared size.')
        return
      }
      // The row carries no foreign key to the session, so a session deleted
      // while the bytes were arriving has to be caught here.
      if (options.sessionWorkspace(ticket.sessionId) !== ticket.workspaceId) {
        fail('session_gone', 404, 'not_found', 'Session not found.')
        return
      }
      if (!settle()) return
      try {
        renameSync(partialPath, finalPath)
        insert.run(
          artifactId,
          ticket.workspaceId,
          ticket.clientId,
          storageKey,
          ticket.name,
          ticket.mimeType,
          received,
          JSON.stringify({ sessionId: ticket.sessionId, source: 'prompt' }),
          clock(),
        )
      } catch (error) {
        // A workspace deleted mid-transfer fails the insert; the bytes must
        // not outlive the row that would have named them.
        rmSync(partialPath, { force: true })
        rmSync(finalPath, { force: true })
        options.log('error', 'upload could not be recorded', {
          reason: error instanceof Error ? error.message : 'unknown',
        })
        reject('storage', { sessionId: ticket.sessionId, receivedBytes: received }, who)
        respond(response, 500, errorResult(null, 'internal', 'The upload could not be stored.'))
        return
      }
      respond(
        response,
        201,
        UploadResultSchema.parse({
          artifactId,
          sessionId: ticket.sessionId,
          name: ticket.name,
          mimeType: ticket.mimeType,
          sizeBytes: received,
        }),
      )
    }

    request.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      if (received > ticket.sizeBytes) {
        fail('oversized', 413, 'validation', 'The upload is larger than the ticket allows.')
      }
    })
    // A dropped connection ends the request without `end`, as an error, a
    // bare close, or both.
    const interrupted = () => {
      if (!request.complete && abandon()) {
        reject('interrupted', { sessionId: ticket.sessionId, receivedBytes: received }, who)
      }
    }
    request.on('close', interrupted)
    request.on('error', interrupted)
    file.on('error', () => fail('storage', 500, 'internal', 'The upload could not be stored.'))
    file.on('finish', () => {
      written = true
    })
    file.on('close', () => {
      if (written && !settled) complete()
      else rmSync(partialPath, { force: true })
    })
    request.pipe(file)
  }

  return {
    get pendingTicketCount() {
      pruneExpired()
      return tickets.size
    },

    dispatch(command: CommandEnvelope, context?: CommandContext): unknown | undefined {
      return command.name === UPLOAD_TICKET_CAPABILITY ? createTicket(command, context) : undefined
    },

    /** Handle an upload route. Returns false when the request is not one. */
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      const path = request.url?.split('?')[0] ?? ''
      if (!path.startsWith(UPLOAD_PATH_PREFIX)) return false
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-methods': 'PUT',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
          'cache-control': 'no-store',
        })
        response.end()
        return true
      }
      if (request.method !== 'PUT') {
        respond(response, 405, errorResult(null, 'validation', 'Uploads use PUT.'), {
          allow: 'PUT',
        })
        return true
      }
      const remoteAddress = request.socket.remoteAddress ?? 'unknown'
      const command = `PUT ${UPLOAD_PATH_PREFIX}`
      const lockout = options.rateLimiter.blocked('auth_failure', remoteAddress)
      if (!lockout.allowed) {
        options.audit.record({
          type: 'rate_limited',
          remoteAddress,
          command,
          details: { policy: 'auth_failure', retryAfterMs: lockout.retryAfterMs },
        })
        respond(
          response,
          429,
          errorResult(null, 'unavailable', 'Too many failed credential attempts.'),
          { 'retry-after': String(Math.ceil(lockout.retryAfterMs / 1000)), connection: 'close' },
        )
        return true
      }
      const client = options.authenticate(
        /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1],
      )
      if (!client) {
        options.rateLimiter.consume('auth_failure', remoteAddress)
        options.audit.record({
          type: 'auth.failed',
          remoteAddress,
          command,
          details: {
            presented: request.headers.authorization !== undefined,
            origin: auditValue(request.headers.origin),
          },
        })
        refuse(request, response, 401, 'auth', 'A valid client credential is required.')
        return true
      }
      const who = { clientId: client.clientId, remoteAddress, command }
      const key = hashTicket(path.slice(UPLOAD_PATH_PREFIX.length))
      const ticket = tickets.get(key)
      // Unknown, already used and swept tickets are one answer on purpose.
      if (!ticket) {
        reject('unknown_ticket', {}, who)
        refuse(request, response, 404, 'not_found', 'The upload ticket is not valid.')
        return true
      }
      if (ticket.clientId !== client.clientId) {
        // The ticket stays valid for its owner: a stranger must not be able
        // to burn it by presenting it.
        reject('foreign_ticket', { sessionId: ticket.sessionId }, who)
        refuse(request, response, 404, 'not_found', 'The upload ticket is not valid.')
        return true
      }
      // Single use: the ticket is spent before a byte is read, so a second
      // PUT racing the first finds nothing.
      tickets.delete(key)
      if (ticket.expiresAt <= clock()) {
        reject('expired_ticket', { sessionId: ticket.sessionId }, who)
        refuse(request, response, 410, 'not_found', 'The upload ticket has expired.')
        return true
      }
      if (!client.capabilities.includes('operate')) {
        options.audit.record({
          type: 'capability.denied',
          clientId: client.clientId,
          remoteAddress,
          command,
          details: { requiredCapability: 'operate' },
        })
        refuse(
          request,
          response,
          403,
          'capability_missing',
          'Uploads require the operate capability.',
        )
        return true
      }
      if (
        options.sessionWorkspace(ticket.sessionId) !== ticket.workspaceId ||
        !options.resolveWorkspace(ticket.workspaceId, { clientId: client.clientId, command })
      ) {
        reject('session_gone', { sessionId: ticket.sessionId }, who)
        refuse(request, response, 404, 'not_found', 'Session not found.')
        return true
      }
      const declared = request.headers['content-length']
      if (declared !== undefined && Number(declared) !== ticket.sizeBytes) {
        reject(
          Number(declared) > ticket.sizeBytes ? 'oversized' : 'size_mismatch',
          { sessionId: ticket.sessionId, contentLength: auditValue(declared) },
          who,
        )
        refuse(
          request,
          response,
          Number(declared) > ticket.sizeBytes ? 413 : 400,
          'validation',
          'The upload does not match the declared size.',
        )
        return true
      }
      receive(request, response, ticket, who)
      return true
    },

    /**
     * End a client's uploads, e.g. after its credential is revoked: outstanding
     * tickets are dropped and transfers already past authentication are cut.
     */
    revokeClient(clientId: string): void {
      for (const [key, ticket] of tickets) if (ticket.clientId === clientId) tickets.delete(key)
      for (const [cut, owner] of [...transfers]) if (owner === clientId) cut('revoked')
    },

    /** Cut every in-flight transfer and remove its partial file. */
    close(): void {
      tickets.clear()
      for (const cut of [...transfers.keys()]) cut()
    },
  }
}

export type UploadService = ReturnType<typeof createUploadService>
