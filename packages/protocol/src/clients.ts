import { z } from 'zod'
import { AccessGrantSchema } from './access-grant.js'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { CommandEnvelopeSchema, EventEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * The clients authorized to reach an environment, as its owner manages them:
 * list them, name them, revoke them, and replace the owner's own credential.
 * Every command here needs `admin`
 * (`docs/decisions/capability-scopes-and-credentials.md`).
 */
export const CLIENT_LIST_CAPABILITY = 'client.list' as const
export const CLIENT_RENAME_CAPABILITY = 'client.rename' as const
export const CLIENT_REVOKE_CAPABILITY = 'client.revoke' as const
export const CLIENT_REVOKE_OTHERS_CAPABILITY = 'client.revoke_others' as const
export const CLIENT_OWNER_ROTATE_CAPABILITY = 'client.owner.rotate' as const
/**
 * Sent whenever the list below changes (a client is named, revoked, minted,
 * connects or disconnects) to every connection that has listed the clients.
 */
export const CLIENT_LIST_CHANGED_EVENT = 'client.list.changed' as const

/**
 * The close a socket gets when its client's credential is revoked (or the
 * owner credential it used is rotated). Terminal: the credential will never
 * work again, so a client must not redial with it.
 */
export const CLIENT_REVOKED_CLOSE_CODE = 4401 as const
export const CLIENT_REVOKED_CLOSE_REASON = 'revoked' as const
/**
 * The reason that goes with `4401` when a browser's socket offered a
 * credential the environment does not know (never issued, or revoked while
 * the client was away). A browser cannot read why an upgrade was refused, so
 * the environment completes the upgrade and closes it with this instead.
 */
export const CLIENT_UNAUTHORIZED_CLOSE_REASON = 'unauthorized' as const

/**
 * The close every socket gets when the environment server shuts down on
 * purpose. A client can tell from it that the server stopped, which a
 * gateway in front of it (a tunnel) cannot say on its behalf.
 */
export const SERVER_SHUTDOWN_CLOSE_CODE = 1001 as const
export const SERVER_SHUTDOWN_CLOSE_REASON = 'server_shutdown' as const

/** The most clients one device list carries. */
export const CLIENT_LIST_MAX = 1024

/** The longest name a client can be given; the same cap the server applies when it mints one. */
export const CLIENT_LABEL_MAX_LENGTH = 128

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

/**
 * A device's name as a person sets it, for pairing and for the device list:
 * surrounding space is dropped, and it must still say something. Control and
 * format characters are refused: a line break would garble the list, and a
 * bidi override or a zero-width joiner could make one device's entry read as
 * another's.
 */
export const ClientLabelSchema = z
  .string()
  .trim()
  .min(1, 'A name is required.')
  .max(CLIENT_LABEL_MAX_LENGTH, `A name can be at most ${CLIENT_LABEL_MAX_LENGTH} characters.`)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'A name cannot contain control or format characters.')

/**
 * - `owner`: minted by the environment's own process for the machine it runs
 *   on. No other client can revoke it; it is replaced by rotating it.
 * - `paired`: enrolled from a pairing link.
 * - `cloud`: enrolled through the account service; never holds `admin`.
 */
export const ClientKindSchema = z.enum(['owner', 'paired', 'cloud'])

/** One live (not revoked, not expired) authorized client. Credentials never appear here. */
export const AuthorizedClientSchema = z.strictObject({
  clientId: EntityIdSchema,
  label: z.string().min(1).max(CLIENT_LABEL_MAX_LENGTH),
  kind: ClientKindSchema,
  capabilities: AccessGrantSchema,
  createdAt: TimestampSchema,
  /** The last accepted connection or request; null for a client that never connected. */
  lastSeenAt: TimestampSchema.nullable(),
  /** When the credential stops working unless the client connects again first. */
  expiresAt: TimestampSchema,
  /** Whether the client has a socket open to the environment right now. */
  connected: z.boolean(),
})

/**
 * The live clients, owner first and then most recently seen first, and which
 * of them is the client reading the list. Revoked and expired clients are
 * kept by the environment for audit but are not listed.
 */
export const AuthorizedClientListSchema = z.strictObject({
  clients: z.array(AuthorizedClientSchema).max(CLIENT_LIST_MAX),
  currentClientId: EntityIdSchema,
  /**
   * Listed clients left out past `CLIENT_LIST_MAX`, the least recently seen.
   * They still work, and "revoke all other clients" still reaches them.
   */
  omitted: z.number().int().nonnegative(),
})

export const ClientCommandSchemas = {
  [CLIENT_LIST_CAPABILITY]: command(CLIENT_LIST_CAPABILITY, z.null()),
  [CLIENT_RENAME_CAPABILITY]: command(
    CLIENT_RENAME_CAPABILITY,
    z.strictObject({ clientId: EntityIdSchema, label: ClientLabelSchema }),
  ),
  /** Refused for the caller itself and for the owner, which is rotated instead. */
  [CLIENT_REVOKE_CAPABILITY]: command(
    CLIENT_REVOKE_CAPABILITY,
    z.strictObject({ clientId: EntityIdSchema }),
  ),
  /** Revoke every client except the caller and the owner. */
  [CLIENT_REVOKE_OTHERS_CAPABILITY]: command(CLIENT_REVOKE_OTHERS_CAPABILITY, z.null()),
  /**
   * Replace the owner's credential. Only the owner may ask. The new credential
   * is answered once, on this command, and published to the environment's
   * data directory; every socket that used the old one is then closed.
   */
  [CLIENT_OWNER_ROTATE_CAPABILITY]: command(CLIENT_OWNER_ROTATE_CAPABILITY, z.null()),
} as const

export const ClientResponseSchemas = {
  [CLIENT_LIST_CAPABILITY]: response(AuthorizedClientListSchema),
  [CLIENT_RENAME_CAPABILITY]: response(z.strictObject({ client: AuthorizedClientSchema })),
  [CLIENT_REVOKE_CAPABILITY]: response(z.strictObject({ clientId: EntityIdSchema })),
  [CLIENT_REVOKE_OTHERS_CAPABILITY]: response(
    z.strictObject({ revokedClientIds: z.array(EntityIdSchema) }),
  ),
  [CLIENT_OWNER_ROTATE_CAPABILITY]: response(
    z.strictObject({
      client: AuthorizedClientSchema,
      /** The new owner credential; the only time it travels on the socket. */
      credential: z.string().regex(/^omc1\.[A-Za-z0-9_-]{43}$/),
    }),
  ),
} as const

/**
 * The whole list again, as the receiving connection would read it. A current
 * reading, not history: it has no cursor and is not replayed, so a client
 * that reconnects lists the clients again.
 */
export const ClientListChangedEventSchema = EventEnvelopeSchema.extend({
  name: z.literal(CLIENT_LIST_CHANGED_EVENT),
  payload: AuthorizedClientListSchema,
})

export type ClientKind = z.infer<typeof ClientKindSchema>
export type AuthorizedClient = z.infer<typeof AuthorizedClientSchema>
export type AuthorizedClientList = z.infer<typeof AuthorizedClientListSchema>
export type ClientListChangedEvent = z.infer<typeof ClientListChangedEventSchema>
export type ClientCommandName = keyof typeof ClientCommandSchemas
