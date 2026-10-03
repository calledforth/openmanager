import {
  CLIENT_LIST_CAPABILITY,
  CLIENT_LIST_CHANGED_EVENT,
  CLIENT_LIST_MAX,
  CLIENT_OWNER_ROTATE_CAPABILITY,
  CLIENT_RENAME_CAPABILITY,
  CLIENT_REVOKE_CAPABILITY,
  CLIENT_REVOKE_OTHERS_CAPABILITY,
  ClientCommandSchemas,
  ClientListChangedEventSchema,
  ClientResponseSchemas,
  type AuthorizedClient,
  type CommandEnvelope,
  type ErrorCode,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import type { AuthenticatedClient, AuthorizedClients, ClientRecord } from './authorized-clients.ts'
import type { CommandContext } from './command-context.ts'
import type { Logger } from './logger.ts'

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

const notAuthorized = (requestId: string) =>
  errorResult(requestId, 'not_found', 'That client is not authorized.')

const iso = (ms: number) => new Date(ms).toISOString()

/** The live connections the service needs to see and cut. */
export interface ClientSockets {
  connectedClientIds(): ReadonlySet<string>
  hasFollowers(topic: string): boolean
  publishToFollowers(topic: string, build: (client: AuthenticatedClient) => EventEnvelope): void
  disconnectClient(clientId: string): number
}

export interface OwnerRotation {
  client: AuthenticatedClient
  credential: string
  previousId: string
}

/**
 * The owner's device list: who may reach this environment, what each is
 * called, when it was last seen, and revoking it. Every command needs
 * `admin`, which the socket checks before this service is asked; the rules
 * on whom a caller may revoke are checked here
 * (`docs/decisions/capability-scopes-and-credentials.md`, "Revocation").
 *
 * A revoke takes effect in three places at once: the row (so the credential
 * stops authenticating HTTP and upgrades), every live socket of that client
 * (closed `4401 revoked`), and its upload tickets and transfers.
 */
export function createClientService(deps: {
  clients: Pick<
    AuthorizedClients,
    'list' | 'countListed' | 'get' | 'rename' | 'revoke' | 'revokeAllExcept'
  >
  sockets: () => ClientSockets
  uploads: { revokeClient(clientId: string): void }
  /** Replace the owner credential; the server keeps track of which row is the owner. */
  rotateOwner: (requestedBy: string | undefined) => OwnerRotation
  log: Logger
}) {
  let publishScheduled = false
  let stopped = false

  const toWire = (record: ClientRecord, connected: ReadonlySet<string>): AuthorizedClient => ({
    clientId: record.clientId,
    label: record.label,
    kind: record.kind,
    capabilities: [...record.capabilities],
    createdAt: iso(record.createdAt),
    lastSeenAt: record.lastSeenAt === null ? null : iso(record.lastSeenAt),
    expiresAt: iso(record.expiresAt),
    connected: connected.has(record.clientId),
  })

  /** The list as the wire carries it, less who is reading it. */
  const listWire = () => {
    const connected = deps.sockets().connectedClientIds()
    const clients = deps.clients.list(connected).map((record) => toWire(record, connected))
    const omitted = Math.max(0, deps.clients.countListed(connected) - CLIENT_LIST_MAX)
    return { clients, omitted }
  }

  /**
   * Tell every connection that listed the clients that the list changed.
   * Listing needs `admin`, so only admin holders follow it, and a socket that
   * never opened the device list is not told about every connect. Coalesced
   * to one read per turn of the event loop: a revoke-all closes many
   * sockets, and each close is a change.
   */
  const announce = () => {
    if (publishScheduled || stopped) return
    publishScheduled = true
    setImmediate(() => {
      publishScheduled = false
      if (stopped) return
      try {
        const sockets = deps.sockets()
        if (!sockets.hasFollowers(CLIENT_LIST_CHANGED_EVENT)) return
        const list = listWire()
        sockets.publishToFollowers(CLIENT_LIST_CHANGED_EVENT, (client) =>
          ClientListChangedEventSchema.parse({
            type: 'event',
            name: CLIENT_LIST_CHANGED_EVENT,
            payload: { ...list, currentClientId: client.clientId },
          }),
        )
      } catch (error) {
        deps.log('error', 'client list was not announced', { reason: String(error) })
      }
    })
  }

  /**
   * Cut a client that no longer has a credential. A socket that authenticated
   * just before the revoke may still be finishing its upgrade, so a second
   * pass after the upgrade handlers have run closes it too.
   */
  const cut = (clientId: string) => {
    deps.sockets().disconnectClient(clientId)
    deps.uploads.revokeClient(clientId)
    setImmediate(() => {
      if (!stopped) deps.sockets().disconnectClient(clientId)
    })
  }

  const revoke = (clientId: string, revokedBy?: string): boolean => {
    const revoked = deps.clients.revoke(clientId, revokedBy)
    if (revoked) {
      cut(clientId)
      announce()
    }
    return revoked
  }

  const rotateOwner = (requestedBy?: string, afterReply?: CommandContext['afterReply']) => {
    const rotated = deps.rotateOwner(requestedBy)
    // The old credential stopped authenticating when its row was revoked. Its
    // sockets close once the caller has its new credential: closing first
    // would drop the answer that carries it.
    if (afterReply) afterReply(() => cut(rotated.previousId))
    else cut(rotated.previousId)
    announce()
    return rotated
  }

  const list = (command: CommandEnvelope, context: CommandContext) => {
    const parsed = ClientCommandSchemas[CLIENT_LIST_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid client list request.')
    }
    context.follow?.(CLIENT_LIST_CHANGED_EVENT)
    return ClientResponseSchemas[CLIENT_LIST_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { ...listWire(), currentClientId: context.clientId },
    })
  }

  const rename = (command: CommandEnvelope, context: CommandContext) => {
    const parsed = ClientCommandSchemas[CLIENT_RENAME_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      const issue = parsed.error.issues.find((item) => item.path.at(-1) === 'label')
      return errorResult(command.requestId, 'validation', issue?.message ?? 'Invalid rename.')
    }
    const { clientId, label } = parsed.data.payload
    const connected = deps.sockets().connectedClientIds()
    // The owner names its own machine; a paired admin leaves the owner alone.
    if (
      deps.clients.get(clientId, connected)?.kind === 'owner' &&
      deps.clients.get(context.clientId, [context.clientId])?.kind !== 'owner'
    ) {
      return errorResult(
        command.requestId,
        'capability_missing',
        'Only the owner can rename itself.',
      )
    }
    const record = deps.clients.rename(clientId, label, connected)
    if (!record) return notAuthorized(command.requestId)
    announce()
    return ClientResponseSchemas[CLIENT_RENAME_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { client: toWire(record, connected) },
    })
  }

  const revokeOne = (command: CommandEnvelope, context: CommandContext) => {
    const parsed = ClientCommandSchemas[CLIENT_REVOKE_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid revoke request.')
    }
    const { clientId } = parsed.data.payload
    if (clientId === context.clientId) {
      return errorResult(
        command.requestId,
        'validation',
        'A device cannot revoke itself. Revoke it from another device.',
      )
    }
    const record = deps.clients.get(clientId, deps.sockets().connectedClientIds())
    if (!record) return notAuthorized(command.requestId)
    if (record.kind === 'owner') {
      return errorResult(
        command.requestId,
        'validation',
        'The owner cannot be revoked. Rotate its credential from the owner instead.',
      )
    }
    // Another request may have revoked it since the read above.
    if (!revoke(clientId, context.clientId)) return notAuthorized(command.requestId)
    return ClientResponseSchemas[CLIENT_REVOKE_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { clientId },
    })
  }

  const revokeOthers = (command: CommandEnvelope, context: CommandContext) => {
    const parsed = ClientCommandSchemas[CLIENT_REVOKE_OTHERS_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid revoke request.')
    }
    const revokedClientIds = deps.clients.revokeAllExcept(
      context.clientId,
      deps.sockets().connectedClientIds(),
    )
    for (const clientId of revokedClientIds) cut(clientId)
    if (revokedClientIds.length > 0) announce()
    return ClientResponseSchemas[CLIENT_REVOKE_OTHERS_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { revokedClientIds },
    })
  }

  const rotate = (command: CommandEnvelope, context: CommandContext) => {
    const parsed = ClientCommandSchemas[CLIENT_OWNER_ROTATE_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid rotate request.')
    }
    // Only the owner replaces the owner: a paired admin must not be able to
    // cut the machine the environment runs on off from it.
    if (deps.clients.get(context.clientId, [context.clientId])?.kind !== 'owner') {
      return errorResult(
        command.requestId,
        'capability_missing',
        'Only the owner can rotate the owner credential.',
      )
    }
    let rotated: OwnerRotation
    try {
      rotated = rotateOwner(context.clientId, context.afterReply)
    } catch (error) {
      // The store rolled back and restored the published file: the old
      // credential and every connection that uses it carry on.
      deps.log('error', 'owner credential was not rotated', { reason: String(error) })
      return errorResult(
        command.requestId,
        'internal',
        'The owner credential could not be replaced; the current one still works.',
      )
    }
    const record = deps.clients.get(rotated.client.clientId)
    if (!record) throw new Error('The rotated owner credential is not live.')
    return ClientResponseSchemas[CLIENT_OWNER_ROTATE_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { client: toWire(record, new Set()), credential: rotated.credential },
    })
  }

  return {
    dispatch(command: CommandEnvelope, context: CommandContext): unknown {
      switch (command.name) {
        case CLIENT_LIST_CAPABILITY:
          return list(command, context)
        case CLIENT_RENAME_CAPABILITY:
          return rename(command, context)
        case CLIENT_REVOKE_CAPABILITY:
          return revokeOne(command, context)
        case CLIENT_REVOKE_OTHERS_CAPABILITY:
          return revokeOthers(command, context)
        case CLIENT_OWNER_ROTATE_CAPABILITY:
          return rotate(command, context)
        default:
          return undefined
      }
    },

    /** Revoke a client and cut it off now. The owner is refused by the caller, not here. */
    revoke,

    /** Replace the owner credential and close every socket that used the old one. */
    rotateOwner: (requestedBy?: string) => rotateOwner(requestedBy),

    /** A socket opened or closed, or a client was minted: who is connected changed. */
    announce,

    stop() {
      stopped = true
    },
  }
}
