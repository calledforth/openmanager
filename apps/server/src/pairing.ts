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
  PAIRING_LIST_HISTORY_MS,
  PAIRING_PENDING_LINKS_MAX,
  PAIRING_REDEEM_CAPABILITY,
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
  type PairingLinkStatus,
  type PairingRedeemResponse,
  type PairingRejectionReason,
} from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'
import { insertClientRow } from './authorized-clients.ts'
import { remoteAddressKey, type BudgetKey } from './budget-key.ts'
import type { CommandContext } from './command-context.ts'
import { openEnvironmentDatabase } from './db/database.ts'
import type { RateLimiter } from './rate-limit.ts'

/** The label a paired device gets when neither the link nor the device names it. */
export const DEFAULT_PAIRED_LABEL = 'Paired device'
/** Used and withdrawn links are kept this long for the audit trail, then deleted. */
export const PAIRING_LINK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** `POST /pair` bodies are a token and a label; anything bigger is not one. */
export const PAIRING_EXCHANGE_MAX_BYTES = 4096
/** At most this many links come back from `pairing.list`. */
export const PAIRING_LIST_MAX = 200
/**
 * Close code for a paired device's sockets when redeeming a link changed its
 * grant. The device reconnects with the same credential and gets the new
 * grant; the old sockets would otherwise keep the grant they opened with.
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
  consumed_by_client_id: string | null
  revoked_at: number | null
}

type ListedLinkRow = LinkRow & {
  creator_revoked_at: number | null
  creator_expires_at: number | null
}

type ClientRow = {
  kind: string
  label: string
  scopes_json: string
  expires_at: number
  revoked_at: number | null
}

const LINK_COLUMNS = `
  l.link_id, l.label, l.scopes_json, l.created_by_client_id, l.created_at, l.expires_at,
  l.consumed_at, l.consumed_by_client_id, l.revoked_at
`

const errorResult = (
  requestId: string | null,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) => ({
  type: 'error' as const,
  requestId,
  error: details ? { code, message, details } : { code, message },
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

const isLive = (row: { revoked_at: number | null; expires_at: number } | undefined, now: number) =>
  row !== undefined && row.revoked_at === null && row.expires_at > now

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString())

function statusOf(row: ListedLinkRow, now: number): PairingLinkStatus {
  if (row.consumed_at !== null) return 'used'
  if (row.revoked_at !== null) return 'revoked'
  if (row.expires_at <= now) return 'expired'
  const creatorLive =
    row.creator_expires_at !== null &&
    row.creator_revoked_at === null &&
    row.creator_expires_at > now
  return creatorLive ? 'waiting' : 'void'
}

const toLink = (row: LinkRow, status: PairingLinkStatus): PairingLink | undefined => {
  const capabilities = parseGrant(row.scopes_json)
  if (!capabilities) return undefined
  return {
    linkId: row.link_id,
    label: row.label,
    capabilities: [...capabilities],
    createdByClientId: row.created_by_client_id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    status,
    usedByClientId: row.consumed_by_client_id,
    usedAt: iso(row.consumed_at),
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

const usedRejection = (linkId: string) =>
  new Rejection(401, 'auth', 'used', 'This pairing link was already used.', linkId)
const creatorRejection = (linkId: string) =>
  new Rejection(
    401,
    'auth',
    'creator_revoked',
    'The device that created this pairing link no longer has access.',
    linkId,
  )

type CreateOutcome =
  | { gone: true }
  | { denied: AccessCapability }
  | { full: true }
  | { link: PairingLink; token: string }

/** Who a link is being redeemed for: a device with no credential, or one already paired. */
type RedeemTarget =
  { kind: 'new'; label: string | undefined } | { kind: 'existing'; clientId: string }

type RedeemOutcome =
  | { kind: 'new'; linkId: string; response: PairingExchangeResponse }
  | { kind: 'existing'; linkId: string; response: PairingRedeemResponse }

/**
 * Pairing links and their redemption (CAL-102, CAL-103, CAL-106).
 *
 * An `admin` client creates a link over the socket. A device with no
 * credential trades its token for a `paired` credential at `POST /pair`; a
 * device that is already paired redeems it over its own socket and keeps its
 * identity. Either way the link is used and the client written in one
 * transaction, so a token is redeemed once, and the creator is checked again
 * at that moment: a revoked creator's links are void, a narrowed one's narrow.
 */
export function createPairingService(options: {
  dataDir: string
  audit: AuditLog
  rateLimiter: RateLimiter
  /** Who a refused `POST /pair` is counted against; see `budget-key.ts`. */
  budgetKey?: BudgetKey
  environment: () => { environmentId: string; label: string }
  /**
   * A device's grant changed by redeeming a link. Called as the redeem
   * commits, before its response is sent: the device's sockets must stop
   * serving the old grant at once and close once that response is out.
   */
  onGrantChanged?: (clientId: string) => void
  /**
   * A redeem committed a new paired client or a changed grant, so device
   * lists that are open should be told. Called after the commit.
   */
  onClientsChanged?: () => void
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
  // Every link that can still be redeemed (at most 32) is listed, however much history
  // came after it, so a client can always find and withdraw it; settled
  // links fill the rest of the page, newest first.
  const listedLinks = database.prepare(`
    SELECT ${LINK_COLUMNS}, c.revoked_at AS creator_revoked_at, c.expires_at AS creator_expires_at
    FROM pairing_links l
    LEFT JOIN authorized_clients c ON c.client_id = l.created_by_client_id
    WHERE COALESCE(l.consumed_at, l.revoked_at, l.expires_at) > ?
    ORDER BY (
        l.consumed_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > ?
        AND c.revoked_at IS NULL AND c.expires_at > ?
      ) DESC,
      l.created_at DESC, l.link_id
    LIMIT ${PAIRING_LIST_MAX}
  `)
  // A link whose creator lost access can never be used, so it does not hold
  // a place: revoking a lost phone must not lock the owner out of pairing.
  const waitingCount = database.prepare(`
    SELECT count(*) AS count
    FROM pairing_links l
    JOIN authorized_clients c ON c.client_id = l.created_by_client_id
    WHERE l.consumed_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > ?
      AND c.revoked_at IS NULL AND c.expires_at > ?
  `)
  const linkByHash = database.prepare(`
    SELECT ${LINK_COLUMNS} FROM pairing_links l WHERE l.token_hash = ?
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
  const clientRow = database.prepare(`
    SELECT kind, label, scopes_json, expires_at, revoked_at
    FROM authorized_clients WHERE client_id = ?
  `)
  const regrant = database.prepare(`
    UPDATE authorized_clients SET scopes_json = ?
    WHERE client_id = ? AND kind = 'paired' AND revoked_at IS NULL
  `)

  /** A client's grant as stored now, or undefined when its row is no longer live. */
  const liveGrant = (clientId: string, now: number) => {
    const row = clientRow.get(clientId) as ClientRow | undefined
    return isLive(row, now) ? parseGrant(row!.scopes_json) : undefined
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
      if (!held) return { gone: true }
      const missing = capabilities.find((capability) => !held.includes(capability))
      if (missing) return { denied: missing }
      const { count } = waitingCount.get(now, now) as { count: number }
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
        consumed_by_client_id: null,
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
      return { link: toLink(row, 'waiting')!, token }
    })
    if ('gone' in result) {
      // Revoked or idle-expired since this socket opened. Its next connect
      // will be refused; this command already is.
      return errorResult(command.requestId, 'auth', 'This client no longer has access.')
    }
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
    const now = clock()
    const links = (listedLinks.all(now - PAIRING_LIST_HISTORY_MS, now, now) as ListedLinkRow[])
      .map((row) => toLink(row, statusOf(row, now)))
      .filter((link): link is PairingLink => link !== undefined)
    return PairingResponseSchemas[PAIRING_LIST_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { links },
    })
  }

  const revoke = (command: CommandEnvelope, context: CommandContext | undefined) => {
    const parsed = PairingCommandSchemas[PAIRING_REVOKE_CAPABILITY].safeParse(command)
    if (!parsed.success || !context) {
      return errorResult(command.requestId, 'validation', 'Invalid pairing revoke request.')
    }
    const { linkId } = parsed.data.payload
    const now = clock()
    if (revokeLink.run(now, linkId, now).changes === 0) {
      return errorResult(command.requestId, 'not_found', 'No pairing link is waiting with that id.')
    }
    options.audit.record({
      type: 'pairing.revoked',
      clientId: context.clientId,
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
   * Redeem a token for `target`. Reasons are checked in an order that tells a
   * person what to do: a withdrawn link reads like one that never existed, an
   * expired one says so, a used one says so. Responses are built and checked
   * inside the transaction, so one that could not be sent leaves nothing used.
   */
  const redeem = (
    token: string,
    requested: readonly AccessCapability[] | undefined,
    target: RedeemTarget,
  ): RedeemOutcome & { grantChanged: boolean } => {
    const now = clock()
    const outcome = transaction((): RedeemOutcome & { grantChanged: boolean } => {
      const link = linkByHash.get(hashToken(token)) as LinkRow | undefined
      if (!link || link.revoked_at !== null) {
        throw new Rejection(401, 'auth', 'invalid', 'This pairing link is not valid.')
      }
      if (link.consumed_at !== null) throw usedRejection(link.link_id)
      if (link.expires_at <= now) {
        throw new Rejection(401, 'auth', 'expired', 'This pairing link has expired.', link.link_id)
      }
      let existing: ClientRow | undefined
      if (target.kind === 'existing') {
        existing = clientRow.get(target.clientId) as ClientRow | undefined
        if (!isLive(existing, now)) {
          throw new Rejection(401, 'auth', 'invalid', 'This device no longer has access.')
        }
        if (existing!.kind !== 'paired') {
          // The owner (or an account-enrolled device) needs no link, and
          // turning it into a paired client would demote it.
          throw new Rejection(
            409,
            'conflict',
            'already_authorized',
            'This device is already authorized for this environment.',
            link.link_id,
          )
        }
      }
      const offered = parseGrant(link.scopes_json)
      const creatorGrant = liveGrant(link.created_by_client_id, now)
      if (!offered || !creatorGrant) throw creatorRejection(link.link_id)
      const asked = requested ?? offered
      if (asked.some((capability) => !offered.includes(capability))) {
        throw new Rejection(
          400,
          'validation',
          'grant_exceeds_link',
          'The pairing link does not offer every capability asked for.',
          link.link_id,
        )
      }
      // The creator is checked again now: narrowing it narrows its links.
      const grant = canonical(asked.filter((capability) => creatorGrant.includes(capability)))
      if (!grant.includes('read')) throw creatorRejection(link.link_id)

      if (target.kind === 'existing') {
        const previous = canonical(parseGrant(existing!.scopes_json) ?? [])
        if (regrant.run(JSON.stringify(grant), target.clientId).changes === 0) {
          throw new Rejection(401, 'auth', 'invalid', 'This device no longer has access.')
        }
        if (consumeLink.run(now, target.clientId, link.link_id, now).changes === 0) {
          throw usedRejection(link.link_id)
        }
        const grantChanged = previous.join(' ') !== grant.join(' ')
        return {
          kind: 'existing',
          linkId: link.link_id,
          grantChanged,
          response: PairingResponseSchemas[PAIRING_REDEEM_CAPABILITY].shape.payload.parse({
            clientId: target.clientId,
            clientLabel: existing!.label,
            grant,
            grantChanged,
          }),
        }
      }
      const minted = insertClientRow(
        database,
        {
          label: link.label ?? target.label ?? DEFAULT_PAIRED_LABEL,
          kind: 'paired',
          capabilities: grant,
        },
        now,
      )
      if (consumeLink.run(now, minted.client.clientId, link.link_id, now).changes === 0) {
        throw usedRejection(link.link_id)
      }
      const environment = options.environment()
      return {
        kind: 'new',
        linkId: link.link_id,
        grantChanged: false,
        response: PairingExchangeResponseSchema.parse({
          environmentId: environment.environmentId,
          label: environment.label,
          kind: 'paired',
          clientId: minted.client.clientId,
          clientLabel: minted.client.label,
          grant: [...minted.client.capabilities],
          credential: minted.credential,
        }),
      }
    })
    if (outcome.kind === 'new' || outcome.grantChanged) {
      try {
        options.onClientsChanged?.()
      } catch (error) {
        // The redeem has committed; a failed announcement must not undo its answer.
        options.onError?.(error)
      }
    }
    return outcome
  }

  /**
   * Failed attempts count against the `pairing` limit for `key` (a remote
   * address, or a client for socket redeems). Successful ones do not: they
   * needed a token an admin handed out, and several devices pairing from one
   * network in the same minute must not lock each other out.
   */
  const limited = (
    key: string,
    command: string,
    who: { remoteAddress?: string; clientId?: string },
  ) => {
    const lockout = options.rateLimiter.blocked('pairing', key)
    if (lockout.allowed) return undefined
    options.audit.record({
      type: 'rate_limited',
      ...who,
      command,
      details: { policy: 'pairing', retryAfterMs: lockout.retryAfterMs },
    })
    return lockout.retryAfterMs
  }

  const rejected = (
    error: Rejection,
    key: string,
    command: string,
    who: { remoteAddress?: string; clientId?: string },
    origin?: string,
  ) => {
    options.rateLimiter.consume('pairing', key)
    options.audit.record({
      type: 'pairing.rejected',
      ...who,
      command,
      details: {
        reason: error.reason,
        linkId: error.linkId ?? null,
        ...(origin !== undefined ? { origin: auditValue(origin) } : {}),
      },
    })
  }

  const redeemCommand = (command: CommandEnvelope, context: CommandContext | undefined) => {
    const parsed = PairingCommandSchemas[PAIRING_REDEEM_CAPABILITY].safeParse(command)
    if (!context) return errorResult(command.requestId, 'validation', 'Invalid redeem request.')
    const key = `client:${context.clientId}`
    const who = { clientId: context.clientId }
    const retryAfterMs = limited(key, PAIRING_REDEEM_CAPABILITY, who)
    if (retryAfterMs !== undefined) {
      return errorResult(command.requestId, 'unavailable', 'Too many pairing attempts.', {
        policy: 'pairing',
        retryAfterMs,
      })
    }
    try {
      if (!parsed.success) {
        throw new Rejection(400, 'validation', 'malformed', 'Invalid redeem request.')
      }
      const { token, capabilities } = parsed.data.payload
      const outcome = redeem(token, capabilities, { kind: 'existing', clientId: context.clientId })
      if (outcome.kind !== 'existing') throw new Error('Redeem minted a client for a socket.')
      options.audit.record({
        type: 'pairing.exchanged',
        clientId: context.clientId,
        command: PAIRING_REDEEM_CAPABILITY,
        details: {
          linkId: outcome.linkId,
          existingClient: true,
          capabilities: outcome.response.grant.join(' '),
        },
      })
      // Before the response goes out, so a frame batched behind this one is
      // not served under the old grant; the sockets close after the response.
      if (outcome.grantChanged) options.onGrantChanged?.(context.clientId)
      return PairingResponseSchemas[PAIRING_REDEEM_CAPABILITY].parse({
        type: 'response',
        requestId: command.requestId,
        payload: outcome.response,
      })
    } catch (error) {
      if (!(error instanceof Rejection)) throw error
      rejected(error, key, PAIRING_REDEEM_CAPABILITY, who)
      return errorResult(command.requestId, error.code, error.message, { reason: error.reason })
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

  const exchangeHttp = async (request: IncomingMessage, response: ServerResponse) => {
    const remoteAddress = request.socket.remoteAddress ?? 'unknown'
    const budget = (options.budgetKey ?? remoteAddressKey)(request)
    const command = `POST ${PAIRING_EXCHANGE_PATH}`
    const who = { remoteAddress }
    const tooMany = (retryAfterMs: number, headers: Record<string, string> = {}) =>
      send(response, 429, errorResult(null, 'unavailable', 'Too many pairing attempts.'), {
        'retry-after': String(Math.ceil(retryAfterMs / 1000)),
        ...headers,
      })
    const retryAfterMs = limited(budget, command, who)
    if (retryAfterMs !== undefined) {
      request.resume()
      tooMany(retryAfterMs)
      return
    }
    const text = await readBody(request)
    // Checked again now the body is in, before anything else is done with
    // it: requests held open together all passed the first check, and the
    // failures among them since count here. Nothing yields between this
    // check and the redeem.
    const retryAfterBody = limited(budget, command, who)
    if (retryAfterBody !== undefined) {
      tooMany(retryAfterBody, text === undefined ? { connection: 'close' } : {})
      return
    }
    if (text === undefined) {
      // A refused attempt like any other: it counts against the budget.
      const error = new Rejection(413, 'validation', 'malformed', 'Pairing request is too large.')
      rejected(error, budget, command, who, request.headers.origin)
      send(
        response,
        error.status,
        errorResult(null, error.code, error.message, { reason: error.reason }),
        { connection: 'close' },
      )
      return
    }
    try {
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new Rejection(400, 'validation', 'malformed', 'Pairing request must be JSON.')
      }
      const parsed = PairingExchangeRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new Rejection(400, 'validation', 'malformed', 'Invalid pairing request.')
      }
      const { token, capabilities, label } = parsed.data
      const outcome = redeem(token, capabilities, { kind: 'new', label })
      if (outcome.kind !== 'new') throw new Error('Exchange redeemed for an existing client.')
      options.audit.record({
        type: 'pairing.exchanged',
        clientId: outcome.response.clientId,
        remoteAddress,
        command,
        details: {
          linkId: outcome.linkId,
          existingClient: false,
          capabilities: outcome.response.grant.join(' '),
        },
      })
      options.audit.record({
        type: 'token.issued',
        clientId: outcome.response.clientId,
        command,
        details: { kind: 'paired', label: outcome.response.clientLabel },
      })
      send(response, 200, outcome.response)
    } catch (error) {
      if (!(error instanceof Rejection)) {
        options.onError?.(error)
        send(response, 500, errorResult(null, 'internal', 'Pairing failed.'))
        return
      }
      rejected(error, budget, command, who, request.headers.origin)
      send(
        response,
        error.status,
        errorResult(null, error.code, error.message, { reason: error.reason }),
      )
    }
  }

  return {
    dispatch(command: CommandEnvelope, context?: CommandContext): unknown | undefined {
      switch (command.name) {
        case PAIRING_CREATE_CAPABILITY:
          return create(command, context)
        case PAIRING_LIST_CAPABILITY:
          return list(command)
        case PAIRING_REVOKE_CAPABILITY:
          return revoke(command, context)
        case PAIRING_REDEEM_CAPABILITY:
          return redeemCommand(command, context)
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
        request.resume()
        send(response, 405, errorResult(null, 'validation', 'Pairing uses POST.'), {
          allow: 'POST',
        })
        return true
      }
      exchangeHttp(request, response).catch((error: unknown) => {
        options.onError?.(error)
        if (!response.headersSent) {
          send(response, 500, errorResult(null, 'internal', 'Pairing failed.'))
        } else {
          response.destroy()
        }
      })
      return true
    },

    close(): void {
      database.close()
    },
  }
}

export type PairingService = ReturnType<typeof createPairingService>
