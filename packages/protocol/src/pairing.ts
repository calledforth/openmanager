import { z } from 'zod'
import { AccessGrantSchema } from './access.js'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * Pairing: how a device is authorized to an environment without an account.
 * An `admin` client creates a short-lived, single-use pairing link. A device
 * with no credential trades the link's token for one at `POST /pair`; a device
 * that is already paired redeems it over its authenticated socket instead
 * (`pairing.redeem`), so its credential never goes anywhere a link pointed it.
 *
 * The token is not a credential. It opens one exchange, within
 * `PAIRING_LINK_LIFETIME_MS`, and the environment keeps nothing but its hash.
 * See `docs/decisions/capability-scopes-and-credentials.md` ("Pairing link").
 */
export const PAIRING_CREATE_CAPABILITY = 'pairing.create' as const
export const PAIRING_LIST_CAPABILITY = 'pairing.list' as const
export const PAIRING_REVOKE_CAPABILITY = 'pairing.revoke' as const
export const PAIRING_REDEEM_CAPABILITY = 'pairing.redeem' as const
/**
 * Advertised by `/bootstrap` when the environment answers `POST /pair`. It is
 * an HTTP surface, not a socket command: the device has no credential yet.
 */
export const PAIRING_EXCHANGE_CAPABILITY = 'pairing.exchange' as const
export const PAIRING_EXCHANGE_PATH = '/pair'

export const PAIRING_LINK_LIFETIME_MS = 5 * 60 * 1000
/** How many links can wait at once. Links whose creator lost access do not count. */
export const PAIRING_PENDING_LINKS_MAX = 32
/** How long `pairing.list` keeps reporting a link after it stopped waiting. */
export const PAIRING_LIST_HISTORY_MS = 60 * 60 * 1000

/**
 * 32 symbols, none of them easy to confuse with another (no 0/O, 1/I), so a
 * token read off a screen can be typed. Twelve of them are 60 bits.
 */
export const PAIRING_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const PAIRING_TOKEN_LENGTH = 12
const TOKEN_PATTERN = new RegExp(`^[${PAIRING_TOKEN_ALPHABET}]{${PAIRING_TOKEN_LENGTH}}$`)

/**
 * A token as a person might type it: any case, grouped with spaces or
 * dashes. Returns the canonical form, or `undefined` when it cannot be one.
 */
export function normalizePairingToken(input: string): string | undefined {
  if (input.length > PAIRING_TOKEN_LENGTH * 3) return undefined
  const token = input.replace(/[\s-]/g, '').toUpperCase()
  return TOKEN_PATTERN.test(token) ? token : undefined
}

/** `ABCD-EFGH-JKMN`: how a token is shown to be read aloud or typed. */
export function formatPairingToken(token: string): string {
  return token.match(/.{1,4}/g)?.join('-') ?? token
}

export const PairingTokenSchema = z
  .string()
  .max(PAIRING_TOKEN_LENGTH * 3)
  .transform((value, ctx) => {
    const token = normalizePairingToken(value)
    if (token === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Not a pairing token' })
      return z.NEVER
    }
    return token
  })

/**
 * A device's name as a person sets it. Control and format characters are
 * refused: a bidi override or a zero-width joiner could make one device's
 * entry read as another's in the client list.
 */
export const ClientLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'Labels cannot contain control or format characters')

/**
 * A label the environment already holds. Looser than `ClientLabelSchema`:
 * a stored label may predate its rules, and a response must still carry it.
 */
const StoredClientLabelSchema = z.string().min(1).max(128)

/**
 * Where a link stands. `void` means its creator was revoked or expired, so
 * it can no longer be exchanged.
 */
export const PAIRING_LINK_STATUSES = ['waiting', 'used', 'expired', 'revoked', 'void'] as const
export const PairingLinkStatusSchema = z.enum(PAIRING_LINK_STATUSES)

/**
 * A pairing link as the environment reports it. The token is never part of
 * it: only the client that created the link saw the token, once.
 */
export const PairingLinkSchema = z.strictObject({
  linkId: EntityIdSchema,
  /** The name the paired device gets, or null to let the device suggest one. */
  label: StoredClientLabelSchema.nullable(),
  capabilities: AccessGrantSchema,
  createdByClientId: EntityIdSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  status: PairingLinkStatusSchema,
  /** The device that used the link, once it is `used`. */
  usedByClientId: EntityIdSchema.nullable(),
  usedAt: TimestampSchema.nullable(),
})

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

export const PairingCommandSchemas = {
  /**
   * Create a link. Every capability on it must be one the creating client
   * holds; `admin` must be asked for explicitly, never implied.
   */
  [PAIRING_CREATE_CAPABILITY]: command(
    PAIRING_CREATE_CAPABILITY,
    z.strictObject({
      capabilities: AccessGrantSchema,
      label: ClientLabelSchema.nullable().optional(),
    }),
  ),
  /**
   * Every link still waiting, plus the ones that stopped waiting within
   * `PAIRING_LIST_HISTORY_MS`, so the client that showed a QR code can tell
   * it was used, and by which device.
   */
  [PAIRING_LIST_CAPABILITY]: command(PAIRING_LIST_CAPABILITY, z.null()),
  /** Withdraw a link before it is used. */
  [PAIRING_REVOKE_CAPABILITY]: command(
    PAIRING_REVOKE_CAPABILITY,
    z.strictObject({ linkId: EntityIdSchema }),
  ),
  /**
   * Redeem a link as the device this socket belongs to: an already-paired
   * device keeps its client id, label and credential and takes the link's
   * grant. Its sockets, this one included, close with `grant_changed` after
   * the response when the grant changed, so they reconnect under it.
   */
  [PAIRING_REDEEM_CAPABILITY]: command(
    PAIRING_REDEEM_CAPABILITY,
    z.strictObject({
      token: PairingTokenSchema,
      /** A subset of the link's capabilities; omitted means all of them. */
      capabilities: AccessGrantSchema.optional(),
    }),
  ),
} as const

export const PairingResponseSchemas = {
  [PAIRING_CREATE_CAPABILITY]: response(
    z.strictObject({
      link: PairingLinkSchema,
      /** The only time the token is ever sent. Build the link or QR code from it. */
      token: PairingTokenSchema,
    }),
  ),
  [PAIRING_LIST_CAPABILITY]: response(z.strictObject({ links: z.array(PairingLinkSchema) })),
  [PAIRING_REVOKE_CAPABILITY]: response(z.strictObject({ linkId: EntityIdSchema })),
  [PAIRING_REDEEM_CAPABILITY]: response(
    z.strictObject({
      clientId: EntityIdSchema,
      clientLabel: StoredClientLabelSchema,
      grant: AccessGrantSchema,
      grantChanged: z.boolean(),
    }),
  ),
} as const

/**
 * `POST /pair` body, from a device that holds no credential for the
 * environment. It never carries one: the route came from a link, and a link
 * can point anywhere.
 */
export const PairingExchangeRequestSchema = z.strictObject({
  token: PairingTokenSchema,
  /** A subset of the link's capabilities; omitted means all of them. */
  capabilities: AccessGrantSchema.optional(),
  /** Used when the link has no label, e.g. "Chrome on Android". */
  label: ClientLabelSchema.optional(),
})

/** Same shape as the `/local-owner` answer, so a client stores both the same way. */
export const PairingExchangeResponseSchema = z.strictObject({
  environmentId: EntityIdSchema,
  /** The environment's label. */
  label: z.string(),
  kind: z.literal('paired'),
  clientId: EntityIdSchema,
  /** The name the environment knows this device by. */
  clientLabel: StoredClientLabelSchema,
  grant: AccessGrantSchema,
  /** Store this, keyed by `environmentId`. */
  credential: z.string().min(1).max(256),
})

/**
 * Why an exchange or redeem was refused, in `error.details.reason`. A token
 * that never existed and one that was withdrawn read the same: `invalid`.
 */
export const PAIRING_REJECTION_REASONS = [
  /** The request was not a pairing request at all. */
  'malformed',
  'invalid',
  'expired',
  'used',
  /** The client that created the link was revoked or expired since. */
  'creator_revoked',
  /** Asked for a capability the link does not offer. The link is not used up. */
  'grant_exceeds_link',
  /** An owner or account-enrolled device redeemed a link. The link is not used up. */
  'already_authorized',
] as const
export const PairingRejectionReasonSchema = z.enum(PAIRING_REJECTION_REASONS)

export type PairingLink = z.infer<typeof PairingLinkSchema>
export type PairingLinkStatus = z.infer<typeof PairingLinkStatusSchema>
export type PairingExchangeRequest = z.input<typeof PairingExchangeRequestSchema>
export type PairingExchangeResponse = z.infer<typeof PairingExchangeResponseSchema>
export type PairingRedeemResponse = z.infer<
  (typeof PairingResponseSchemas)[typeof PAIRING_REDEEM_CAPABILITY]
>['payload']
export type PairingRejectionReason = z.infer<typeof PairingRejectionReasonSchema>
