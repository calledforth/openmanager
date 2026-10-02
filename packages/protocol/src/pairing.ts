import { z } from 'zod'
import { AccessGrantSchema } from './access.js'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * Pairing: how a new device is authorized to an environment without an
 * account. An `admin` client creates a short-lived, single-use pairing link;
 * the new device trades the link's token for its own credential over HTTP.
 *
 * The token is not a credential. It only opens one exchange, within
 * `PAIRING_LINK_LIFETIME_MS`, and the environment keeps nothing but its hash.
 * See `docs/decisions/capability-scopes-and-credentials.md` ("Pairing link").
 */
export const PAIRING_CREATE_CAPABILITY = 'pairing.create' as const
export const PAIRING_LIST_CAPABILITY = 'pairing.list' as const
export const PAIRING_REVOKE_CAPABILITY = 'pairing.revoke' as const
/**
 * Advertised by `/bootstrap` when the environment answers `POST /pair`. It is
 * an HTTP surface, not a socket command: the device has no credential yet.
 */
export const PAIRING_EXCHANGE_CAPABILITY = 'pairing.exchange' as const
export const PAIRING_EXCHANGE_PATH = '/pair'

export const PAIRING_LINK_LIFETIME_MS = 5 * 60 * 1000
/** How many unused, unexpired links an environment holds at once. */
export const PAIRING_PENDING_LINKS_MAX = 32

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

export const ClientLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]*$/u, 'Labels cannot contain control characters')

/**
 * A pairing link the environment still holds. The token is never part of it:
 * only the client that created the link saw the token, once.
 */
export const PairingLinkSchema = z.strictObject({
  linkId: EntityIdSchema,
  /** The name the paired device gets, or null to let the device suggest one. */
  label: ClientLabelSchema.nullable(),
  capabilities: AccessGrantSchema,
  createdByClientId: EntityIdSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
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
  /** The links still waiting to be used: not exchanged, revoked or expired. */
  [PAIRING_LIST_CAPABILITY]: command(PAIRING_LIST_CAPABILITY, z.null()),
  /** Withdraw a link before it is used. */
  [PAIRING_REVOKE_CAPABILITY]: command(
    PAIRING_REVOKE_CAPABILITY,
    z.strictObject({ linkId: EntityIdSchema }),
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
} as const

/**
 * `POST /pair` body. `credential` is the device's current credential for this
 * environment, if it has one: a device that is already paired re-pairs as
 * the same client instead of becoming a second one.
 */
export const PairingExchangeRequestSchema = z.strictObject({
  token: PairingTokenSchema,
  /** A subset of the link's capabilities; omitted means all of them. */
  capabilities: AccessGrantSchema.optional(),
  /** Used when the link has no label, e.g. "Chrome on Android". */
  label: ClientLabelSchema.optional(),
  credential: z.string().max(256).optional(),
})

export const PairingExchangeResponseSchema = z.strictObject({
  environmentId: EntityIdSchema,
  /** The environment's label. */
  label: z.string(),
  kind: z.literal('paired'),
  clientId: EntityIdSchema,
  clientLabel: ClientLabelSchema,
  grant: AccessGrantSchema,
  /** Store this, keyed by `environmentId`. */
  credential: z.string().min(1).max(256),
  /** True when an already-paired device re-paired and kept its identity. */
  repaired: z.boolean(),
})

/**
 * Why an exchange was refused, in `error.details.reason`. A token that never
 * existed and one that was withdrawn read the same: `invalid`.
 */
export const PAIRING_REJECTION_REASONS = [
  /** The body was not a pairing request at all. */
  'malformed',
  'invalid',
  'expired',
  'used',
  'creator_revoked',
  'grant_exceeds_link',
  'already_authorized',
] as const
export const PairingRejectionReasonSchema = z.enum(PAIRING_REJECTION_REASONS)

export type PairingLink = z.infer<typeof PairingLinkSchema>
export type PairingExchangeRequest = z.input<typeof PairingExchangeRequestSchema>
export type PairingExchangeResponse = z.infer<typeof PairingExchangeResponseSchema>
export type PairingRejectionReason = z.infer<typeof PairingRejectionReasonSchema>
