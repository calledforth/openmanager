import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  ACCESS_CAPABILITIES,
  AccessGrantSchema,
  PAIRING_CREATE_CAPABILITY,
  PAIRING_EXCHANGE_PATH,
  PAIRING_LINK_LIFETIME_MS,
  PAIRING_LIST_CAPABILITY,
  PAIRING_PENDING_LINKS_MAX,
  PAIRING_REVOKE_CAPABILITY,
  PAIRING_TOKEN_ALPHABET,
  PAIRING_TOKEN_LENGTH,
  PairingCommandSchemas,
  PairingExchangeRequestSchema,
  PairingExchangeResponseSchema,
  PairingResponseSchemas,
  accessDenied,
  type AccessCapability,
  type CommandEnvelope,
  type ErrorCode,
  type PairingExchangeResponse,
  type PairingLink,
  type PairingRejectionReason,
} from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'
import {
  insertClientRow,
  type AuthenticatedClient,
  type AuthorizedClients,
} from './authorized-clients.ts'
import type { CommandContext } from './command-context.ts'
import { openEnvironmentDatabase } from './db/database.ts'
import type { RateLimiter } from './rate-limit.ts'

/** The label a paired device gets when neither the link nor the device names it. */
export const DEFAULT_PAIRED_LABEL = 'Paired device'
/** Exchanged and withdrawn links are kept this long for the audit trail, then deleted. */
export const PAIRING_LINK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** `POST /pair` bodies are a token and a label; anything bigger is not one. */
export const PAIRING_EXCHANGE_MAX_BYTES = 4096
/**
 * Close code for a paired device's sockets when re-pairing changed its grant.
 * The device reconnects with the same credential and gets the new grant; the
 * old sockets would otherwise keep the grant they were opened with.
 */
export const GRANT_CHANGED_CLOSE_CODE = 4403 as const
export const GRANT_CHANGED_CLOSE_REASON = 'grant_changed' as const

type LinkRow = {
  link_id: string
  label: string | null
  scopes_json: string
  created_by_client_id: string
  created_at: number
  expires_at: number
  consumed_at: number | null
  revoked_at: number | null
}

type CreatorRow = { scopes_json: string; expires_at: number; revoked_at: number | null }

const errorResult = (requestId: string | null, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest()

/** Twelve symbols from a 32-symbol alphabet: each random byte's low five bits pick one, unbiased. */
export function mintPairingToken(): string {
  const bytes = randomBytes(PAIRING_TOKEN_LENGTH)
  let token = ''
  for (const byte of bytes) token += PAIRING_TOKEN_ALPHABET[byte & 31]
  return token
}

function parseGrant(scopesJson: string): readonly AccessCapability[] | undefined {
  try {
    const parsed = AccessGrantSchema.safeParse(JSON.parse(scopesJson))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Capabilities in their canonical order, so stored grants compare by value. */
const canonical = (grant: Iterable<AccessCapability>) => {
  const set = new Set(grant)
  return ACCESS_CAPABILITIES.filter((capability) => set.has(capability))
}

const toLink = (row: LinkRow): PairingLink | undefined => {
  const capabilities = parseGrant(row.scopes_json)
  if (!capabilities) return undefined
  return {
    linkId: row.link_id,
    label: row.label,
    capabilities: [...capabilities],
    createdByClientId: row.created_by_client_id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

class Rejection extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly reason: PairingRejectionReason
  readonly linkId: string | undefined

  constructor(
    status: number,
    code: ErrorCode,
    reason: PairingRejectionReason,
    message: string,
    linkId?: string,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.reason = reason
    this.linkId = linkId
  }
}

type CreateOutcome =
  { denied: AccessCapability } | { full: true } | { link: PairingLink; token: string }

/**
 * Pairing links and their exchange (CAL-102, CAL-103, CAL-106).
 *
 * An `admin` client creates a link over the socket; the device being paired
 * trades the link's token for a `paired` credential at `POST /pair`. The link
 * is consumed and the client row minted in one transaction, so a token can
 * never produce two credentials, and the creator is checked again at that
 * moment: a revoked creator's links are void.
 */
export function createPairingService(options: {
  dataDir: string
  clients: Pick<AuthorizedClients, 'authenticate'>
  audit: AuditLog
  rateLimiter: RateLimiter
  environment: () => { environmentId: string; label: string }
  /** A paired device re-paired with a different grant; its open sockets must reconnect. */
  onGrantChanged?: (clientId: string) => void
  onError?: (error: unknown) => void
  clock?: () => number
}) {
  const clock = options.clock ?? Date.now
  const database: DatabaseSync = openEnvironmentDatabase(options.dataDir)
  const insertLink = database.prepare(`
    INSERT INTO pairing_links (
      link_id, token_hash, label, scopes_json, created_by_client_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const pendingLinks = database.prepare(`
    SELECT link_id, label, scopes_json, created_by_client_id, created_at, expires_at,
      consumed_at, revoked_at
    FROM pairing_links
    WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at, link_id
  `)
  const pendingCount = database.prepare(`
    SELECT count(*) AS count FROM pairing_links
    WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `)
  const linkByHash = database.prepare(`
    SELECT link_id, label, scopes_json, created_by_client_id, created_at, expires_at,
      consumed_at, revoked_at
    FROM pairing_links WHERE token_hash = ?
  `)
  const revokeLink = database.prepare(`
    UPDATE pairing_links SET revoked_at = ?
    WHERE link_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `)
  const consumeLink = database.prepare(`
    UPDATE pairing_links SET consumed_at = ?, consumed_by_client_id = ?
    WHERE link_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
  `)
  const pruneLinks = database.prepare(`
    DELETE FROM pairing_links WHERE expires_at < ?
  `)
  const creatorRow = database.prepare(`
    SELECT scopes_json, expires_at, revoked_at FROM authorized_clients WHERE client_id = ?
  `)
  const regrant = database.prepare(`
    UPDATE authorized_clients SET scopes_json = ?
    WHERE client_id = ? AND kind = 'paired' AND revoked_at IS NULL
  `)

  /** The caller's grant as stored now, or undefined when the row is no longer live. */
  const liveGrant = (clientId: string, now: number) => {
    const row = creatorRow.get(clientId) as CreatorRow | undefined
    if (!row || row.revoked_at !== null || row.expires_at <= now) return undefined
    return parseGrant(row.scopes_json)
  }

  const transaction = <T>(body: () => T): T => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        /* The failed statement may already have aborted the transaction. */
      }
      throw error
    }
  }

  const create = (command: CommandEnvelope, context: CommandContext | undefined) => {
    const parsed = PairingCommandSchemas[PAIRING_CREATE_CAPABILITY].safeParse(command)
    if (!parsed.success || !context) {
      return errorResult(command.requestId, 'validation', 'Invalid pairing link request.')
    }
    const { capabilities, label } = parsed.data.payload
    const now = clock()
    const result = transaction((): CreateOutcome => {
      // A client never hands out more than it holds (delegation cap).
      const held = liveGrant(context.clientId, now)
      if (!held) return { denied: 'read' }
      const missing = capabilities.find((capability) => !held.includes(capability))
      if (missing) return { denied: missing }
      const { count } = pendingCount.get(now) as { count: number }
      if (count >= PAIRING_PENDING_LINKS_MAX) return { full: true }
      pruneLinks.run(now - PAIRING_LINK_RETENTION_MS)
      const token = mintPairingToken()
      const row: LinkRow = {
        link_id: randomUUID(),
        label: label ?? null,
        scopes_json: JSON.stringify(canonical(capabilities)),
        created_by_client_id: context.clientId,
        created_at: now,
        expires_at: now + PAIRING_LINK_LIFETIME_MS,
        consumed_at: null,
        revoked_at: null,
      }
      insertLink.run(
        row.link_id,
        hashToken(token),
        row.label,
        row.scopes_json,
        row.created_by_client_id,
        row.created_at,
        row.expires_at,
      )
      return { link: toLink(row)!, token }
    })
    if ('denied' in result) {
      options.audit.record({
        type: 'capability.denied',
        clientId: context.clientId,
        command: PAIRING_CREATE_CAPABILITY,
        details: { requiredCapability: result.denied, reason: 'delegation_cap' },
      })
      return accessDenied(command.requestId, result.denied)
    }
    if ('full' in result) {
      return errorResult(
        command.requestId,
        'conflict',
        `${PAIRING_PENDING_LINKS_MAX} pairing links are already waiting; withdraw one first.`,
      )
    }
    options.audit.record({
      type: 'pairing.issued',
      clientId: context.clientId,
      command: PAIRING_CREATE_CAPABILITY,
      details: {
        linkId: result.link.linkId,
        capabilities: result.link.capabilities.join(' '),
        label: auditValue(result.link.label),
      },
    })
    return PairingResponseSchemas[PAIRING_CREATE_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: result,
    })
  }

  const list = (command: CommandEnvelope) => {
    const parsed = PairingCommandSchemas[PAIRING_LIST_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid pairing list request.')
    }
    const links = (pendingLinks.all(clock()) as LinkRow[])
      .map(toLink)
      .filter((link): link is PairingLink => link !== undefined)
    return PairingResponseSchemas[PAIRING_LIST_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { links },
    })
  }

  const revoke = (command: CommandEnvelope, context: CommandContext | undefined) => {
    const parsed = PairingCommandSchemas[PAIRING_REVOKE_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid pairing revoke request.')
    }
    const { linkId } = parsed.data.payload
    if (revokeLink.run(clock(), linkId, clock()).changes === 0) {
      return errorResult(command.requestId, 'not_found', 'No pairing link is waiting with that id.')
    }
    options.audit.record({
      type: 'pairing.revoked',
      clientId: context?.clientId,
      command: PAIRING_REVOKE_CAPABILITY,
      details: { linkId },
    })
    return PairingResponseSchemas[PAIRING_REVOKE_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { linkId },
    })
  }

  /**
   * Trade a token for a credential. Reasons are checked in an order that
   * tells a person what to do: a withdrawn link reads like one that never
   * existed, an expired one says so, a used one says so.
   */
  const exchange = (
    body: unknown,
  ): { response: PairingExchangeResponse; linkId: string; created: boolean } => {
    const parsed = PairingExchangeRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new Rejection(400, 'validation', 'malformed', 'Invalid pairing request.')
    }
    const request = parsed.data
    // Authenticating the device's current credential moves its last-seen
    // forward; an unknown, revoked or expired one is simply not a re-pair.
    const current: AuthenticatedClient | undefined =
      request.credential === undefined
        ? undefined
        : options.clients.authenticate(request.credential)
    const now = clock()
    const outcome = transaction(() => {
      const link = linkByHash.get(hashToken(request.token)) as LinkRow | undefined
      if (!link || link.revoked_at !== null) {
        throw new Rejection(401, 'auth', 'invalid', 'This pairing link is not valid.')
      }
      if (link.consumed_at !== null) {
        throw new Rejection(
          401,
          'auth',
          'used',
          'This pairing link was already used.',
          link.link_id,
        )
      }
      if (link.expires_at <= now) {
        throw new Rejection(401, 'auth', 'expired', 'This pairing link has expired.', link.link_id)
      }
      if (current && current.kind !== 'paired') {
        // The owner (or an account-enrolled device) needs no link, and turning
        // it into a paired client would demote it. The link stays usable.
        throw new Rejection(
          409,
          'conflict',
          'already_authorized',
          'This device is already authorized for this environment.',
          link.link_id,
        )
      }
      const offered = parseGrant(link.scopes_json)
      const creatorGrant = liveGrant(link.created_by_client_id, now)
      if (!offered || !creatorGrant) {
        throw new Rejection(
          401,
          'auth',
          'creator_revoked',
          'The device that created this pairing link no longer has access.',
          link.link_id,
        )
      }
      const requested = request.capabilities ?? offered
      if (requested.some((capability) => !offered.includes(capability))) {
        throw new Rejection(
          400,
          'validation',
          'grant_exceeds_link',
          'The pairing link does not offer every capability asked for.',
          link.link_id,
        )
      }
      // The creator is checked again now: narrowing it narrows its links.
      const grant = canonical(requested.filter((capability) => creatorGrant.includes(capability)))
      if (!grant.includes('read')) {
        throw new Rejection(
          401,
          'auth',
          'creator_revoked',
          'The device that created this pairing link no longer has access.',
          link.link_id,
        )
      }
      const scopes = JSON.stringify(grant)
      if (current && regrant.run(scopes, current.clientId).changes > 0) {
        if (consumeLink.run(now, current.clientId, link.link_id, now).changes === 0) {
          throw new Rejection(
            401,
            'auth',
            'used',
            'This pairing link was already used.',
            link.link_id,
          )
        }
        return {
          linkId: link.link_id,
          created: false,
          grantChanged: canonical(current.capabilities).join(' ') !== grant.join(' '),
          client: { ...current, capabilities: grant },
          credential: request.credential!,
        }
      }
      const minted = insertClientRow(
        database,
        {
          label: link.label ?? request.label ?? DEFAULT_PAIRED_LABEL,
          kind: 'paired',
          capabilities: grant,
        },
        now,
      )
      if (consumeLink.run(now, minted.client.clientId, link.link_id, now).changes === 0) {
        throw new Rejection(
          401,
          'auth',
          'used',
          'This pairing link was already used.',
          link.link_id,
        )
      }
      return {
        linkId: link.link_id,
        created: true,
        grantChanged: false,
        client: minted.client,
        credential: minted.credential,
      }
    })
    if (outcome.grantChanged) options.onGrantChanged?.(outcome.client.clientId)
    const environment = options.environment()
    return {
      linkId: outcome.linkId,
      created: outcome.created,
      response: PairingExchangeResponseSchema.parse({
        environmentId: environment.environmentId,
        label: environment.label,
        kind: 'paired',
        clientId: outcome.client.clientId,
        clientLabel: outcome.client.label,
        grant: [...outcome.client.capabilities],
        credential: outcome.credential,
        repaired: !outcome.created,
      }),
    }
  }

  const send = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    response.end(JSON.stringify(body))
  }

  const readBody = (request: IncomingMessage) =>
    new Promise<string | undefined>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      request.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.byteLength
        if (size > PAIRING_EXCHANGE_MAX_BYTES) {
          done = true
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (!done) resolve(Buffer.concat(chunks).toString('utf8'))
      })
      request.on('error', reject)
    })

  return {
    dispatch(command: CommandEnvelope, context?: CommandContext): unknown | undefined {
      switch (command.name) {
        case PAIRING_CREATE_CAPABILITY:
          return create(command, context)
        case PAIRING_LIST_CAPABILITY:
          return list(command)
        case PAIRING_REVOKE_CAPABILITY:
          return revoke(command, context)
        default:
          return undefined
      }
    },

    /** Handle `POST /pair` and its preflight. Returns false for any other path. */
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      if (request.url?.split('?')[0] !== PAIRING_EXCHANGE_PATH) return false
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          'cache-control': 'no-store',
        })
        response.end()
        return true
      }
      if (request.method !== 'POST') {
        send(response, 405, errorResult(null, 'validation', 'Pairing uses POST.'), {
          allow: 'POST',
        })
        return true
      }
      const remoteAddress = request.socket.remoteAddress ?? 'unknown'
      const command = `POST ${PAIRING_EXCHANGE_PATH}`
      // Every attempt counts, good or bad: 5 a minute leaves a 60-bit token
      // out of reach and is plenty for a person pairing a phone.
      const decision = options.rateLimiter.consume('pairing', remoteAddress)
      if (!decision.allowed) {
        options.audit.record({
          type: 'rate_limited',
          remoteAddress,
          command,
          details: { policy: 'pairing', retryAfterMs: decision.retryAfterMs },
        })
        request.resume()
        send(response, 429, errorResult(null, 'unavailable', 'Too many pairing attempts.'), {
          'retry-after': String(Math.ceil(decision.retryAfterMs / 1000)),
        })
        return true
      }
      void (async () => {
        let text: string | undefined
        try {
          text = await readBody(request)
        } catch {
          return
        }
        if (text === undefined) {
          send(response, 413, errorResult(null, 'validation', 'Pairing request is too large.'), {
            connection: 'close',
          })
          return
        }
        try {
          let body: unknown
          try {
            body = JSON.parse(text)
          } catch {
            throw new Rejection(400, 'validation', 'malformed', 'Pairing request must be JSON.')
          }
          const result = exchange(body)
          options.audit.record({
            type: 'pairing.exchanged',
            clientId: result.response.clientId,
            remoteAddress,
            command,
            details: {
              linkId: result.linkId,
              repaired: !result.created,
              capabilities: result.response.grant.join(' '),
            },
          })
          if (result.created) {
            options.audit.record({
              type: 'token.issued',
              clientId: result.response.clientId,
              command,
              details: { kind: 'paired', label: result.response.clientLabel },
            })
          }
          send(response, 200, result.response)
        } catch (error) {
          if (!(error instanceof Rejection)) {
            options.onError?.(error)
            send(response, 500, errorResult(null, 'internal', 'Pairing failed.'))
            return
          }
          options.audit.record({
            type: 'pairing.rejected',
            remoteAddress,
            command,
            details: {
              reason: error.reason,
              linkId: error.linkId ?? null,
              origin: auditValue(request.headers.origin),
            },
          })
          send(response, error.status, {
            type: 'error',
            requestId: null,
            error: { code: error.code, message: error.message, details: { reason: error.reason } },
          })
        }
      })().catch(() => undefined)
      return true
    },

    close(): void {
      database.close()
    },
  }
}

export type PairingService = ReturnType<typeof createPairingService>
