import type { AuditRow, Delivery } from './child-protocol.ts'

/**
 * Write and event provenance for the two times the known causes are about:
 * a session's `updatedAt` and a workspace's `lastActivityAt`.
 *
 * A client that holds an older value than the server is explained only when
 * (1) nothing the server handed or owed that client carried a newer value,
 * and (2) the server's value came from a write no event announces to that
 * client: the runtime stamp, boot recovery, or (for workspace recency) a
 * session write whose only announcement is one the client's recency rule
 * does not read (X1). A lost update that did have an event therefore stays
 * unexplained: the event, the delivery log or the proxy's recording shows
 * the newer value was offered.
 *
 * Inputs are the server child's audit (SQLite triggers) and delivery log,
 * and the proxy's recording; never the client's state or the views judged.
 */

export interface Provenance {
  audit: AuditRow[]
  deliveries: Delivery[]
}

/** Which sockets are one client's, and what reached it. */
export interface ClientWire {
  /** The remote ports the server saw for this client's sockets. */
  ports: ReadonlySet<number>
  /**
   * Whether a record the server handed a socket of this client reached the
   * client, from the proxy's recording; `undefined` for a direct link, where
   * a handed record is taken as reached.
   */
  reached?: (key: string, sequence: number, port: number) => boolean | undefined
}

export type Explanation = { cause: string; because: string } | { cause: undefined; because: string }

type EventRow = Extract<AuditRow, { kind: 'event' }>
type SessionWrite = Extract<AuditRow, { kind: 'session' }>
type WorkspaceWrite = Extract<AuditRow, { kind: 'workspace' }>

const TURN_EVENTS = new Set(['turn.started', 'turn.completed', 'turn.interrupted', 'turn.failed'])
const ms = (value: unknown) =>
  value === null ? Number.NEGATIVE_INFINITY : typeof value === 'string' ? Date.parse(value) : NaN
const iso = (value: number) => new Date(value).toISOString()
const isEnvironment = (key: string) => key.startsWith('["environment"')
const unexplained = (because: string): Explanation => ({ cause: undefined, because })
const lastIndex = <T>(items: readonly T[], test: (item: T) => boolean) => {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index]!)) return index
  return -1
}

const events = (p: Provenance) => p.audit.filter((row): row is EventRow => row.kind === 'event')
const sessionWrites = (p: Provenance, sessionId: string) =>
  p.audit.filter(
    (row): row is SessionWrite => row.kind === 'session' && row.sessionId === sessionId,
  )

/** Writes made while a server booted: after a `start` marker and before its `boot`. */
function bootSeqs(p: Provenance): (seq: number) => boolean {
  const spans: Array<[number, number]> = []
  let start: number | undefined
  for (const row of p.audit) {
    if (row.kind === 'start') start = row.seq
    if (row.kind === 'boot' && start !== undefined) {
      spans.push([start, row.seq])
      start = undefined
    }
  }
  return (seq) => spans.some(([from, to]) => seq > from && seq < to)
}

/** The client rule for a session's time: `session.created`, and `session.updated` naming a title or status. */
const announcesSession = (event: EventRow, sessionId: string, value: number) =>
  event.sessionId === sessionId &&
  event.ts === value &&
  isEnvironment(event.scopeKey) &&
  (event.name === 'session.created' ||
    (event.name === 'session.updated' && (event.title || event.status !== null)))

/** What kind of write a session write is, when no event announces its value. */
function silentKind(
  p: Provenance,
  write: SessionWrite,
  booted: (seq: number) => boolean,
): 'stamp' | 'recovery' | undefined {
  if (booted(write.seq)) return 'recovery'
  if (write.op === 'update' && write.newProvider && write.newProvider !== write.oldProvider) {
    return 'stamp'
  }
  return undefined
}

/** This client's sockets (`pid:n`), each with the remote port the server saw. */
function socketsOf(p: Provenance, wire: ClientWire): Map<string, number> {
  const sockets = new Map<string, number>()
  for (const delivery of p.deliveries) {
    if (delivery.s && delivery.port !== undefined && wire.ports.has(delivery.port)) {
      sockets.set(delivery.s, delivery.port)
    }
  }
  return sockets
}

/** Values responses handed this client's sockets. */
function carried(p: Provenance, sockets: ReadonlyMap<string, number>) {
  return p.deliveries.filter(
    (delivery): delivery is Extract<Delivery, { k: 'carried' }> =>
      delivery.k === 'carried' && !!delivery.s && sockets.has(delivery.s),
  )
}

/**
 * Whether the server offered this client a durable record as an event:
 * replayed to one of its sockets, handed to one and reached it, or owed to
 * an open one (subscribed) and never handed over while it stayed open, which
 * is the server's own loss. Not offered: a record handed over and lost on the
 * way (a cut), or not sent because the send closed the socket
 * (slow_consumer); the client recovers past it by replay, which offers it
 * again, or by a snapshot. A subscription request still in hand when the
 * record was published is answered by a read made after it: a replay offers
 * the record, a snapshot already holds it.
 */
function offeredAsEvent(
  p: Provenance,
  wire: ClientWire,
  sockets: ReadonlyMap<string, number>,
  event: EventRow,
): string | undefined {
  for (const delivery of p.deliveries) {
    if (!delivery.s || !sockets.has(delivery.s)) continue
    if (
      delivery.k === 'grant' &&
      delivery.key === event.scopeKey &&
      delivery.replayed.includes(event.sequence)
    ) {
      return `replayed to socket ${delivery.s}`
    }
  }
  for (const delivery of p.deliveries) {
    if (delivery.k !== 'publish' || delivery.key !== event.scopeKey) continue
    if (delivery.seq !== event.sequence) continue
    for (const socket of delivery.sent) {
      if (!sockets.has(socket)) continue
      const reached = wire.reached?.(event.scopeKey, event.sequence, sockets.get(socket)!)
      if (reached !== false) return `handed to socket ${socket}${reached ? ' and reached it' : ''}`
    }
    for (const socket of delivery.withheld) {
      if (sockets.has(socket)) return `owed to open socket ${socket} and never handed over`
    }
  }
  return undefined
}

/**
 * A session's `updatedAt`: the client holds `held`, the server `server`.
 * Explained as RUNTIME_STAMP or SILENT_RECOVERY only when no announcement of
 * a newer value exists and every write after the client's value is one of
 * those silent writes; `wire` adds what responses handed the client.
 */
export function explainSessionTime(
  p: Provenance,
  sessionId: string,
  held: unknown,
  server: unknown,
  wire?: ClientWire,
): Explanation {
  const writes = sessionWrites(p, sessionId).filter((write) => write.op !== 'delete')
  const last = writes.at(-1)
  if (!last) return unexplained(`no write to session ${sessionId} is audited`)
  if (ms(server) !== last.new) {
    return unexplained(`the server's ${String(server)} is not the session's last write`)
  }
  const heldMs = ms(held)
  if (!(heldMs < last.new!)) return unexplained('the client does not hold an older value')
  const from = lastIndex(writes, (write) => write.new === heldMs)
  if (from === -1) {
    return unexplained(`the client holds ${String(held)}, which the server never wrote`)
  }
  for (const event of events(p)) {
    if (event.ts > heldMs && announcesSession(event, sessionId, event.ts)) {
      return unexplained(
        `${event.name} (${event.scopeKey} #${event.sequence}) announced ${iso(event.ts)}: a lost update`,
      )
    }
  }
  if (wire) {
    for (const delivery of carried(p, socketsOf(p, wire))) {
      const value = delivery.sessions[sessionId]
      if (value !== undefined && ms(value) > heldMs) {
        return unexplained(
          `a response handed socket ${delivery.s} ${value}, and the client lost it`,
        )
      }
    }
  }
  const booted = bootSeqs(p)
  const kinds = writes
    .slice(from + 1)
    .map((write) => ({ write, kind: silentKind(p, write, booted) }))
  const unknown = kinds.find(({ kind }) => kind === undefined)
  if (unknown) {
    return unexplained(
      `the write to ${iso(unknown.write.new!)} (audit #${unknown.write.seq}) has no event and is neither the runtime stamp nor boot recovery`,
    )
  }
  const deciding = kinds.at(-1)!
  return deciding.kind === 'stamp'
    ? {
        cause: 'RUNTIME_STAMP',
        because: `audit #${deciding.write.seq} set the provider identity and updated_at with no event`,
      }
    : { cause: 'SILENT_RECOVERY', because: `audit #${deciding.write.seq} is boot recovery` }
}

/**
 * A workspace's `lastActivityAt` (MAX of its sessions' `updated_at` and its
 * `last_used_at`): the client holds `held`, the server `server`. Explained
 * only when nothing offered this client a newer value — no
 * `workspace.updated` or `session.created` above it, no turn event offered
 * to it (`offeredAsEvent`), no response that carried one — and the server's
 * value came from a write announced to it by nothing its rule reads:
 * WORKSPACE_RECENCY_MIRROR (a projected session write: its events are
 * `session.updated`, which the rule does not read, or thread events the
 * client was not offered),
 * RUNTIME_STAMP_RECENCY (the stamp) or SILENT_RECOVERY.
 */
export function explainRecency(
  p: Provenance,
  workspaceId: string,
  held: unknown,
  server: unknown,
  wire: ClientWire,
): Explanation {
  const inWorkspace = new Set(
    p.audit
      .filter(
        (row): row is SessionWrite =>
          row.kind === 'session' && row.op === 'insert' && row.workspaceId === workspaceId,
      )
      .map((row) => row.sessionId),
  )
  const writes = p.audit.filter(
    (row): row is SessionWrite | WorkspaceWrite =>
      (row.kind === 'session' && inWorkspace.has(row.sessionId)) ||
      (row.kind === 'workspace' && row.workspaceId === workspaceId),
  )
  // The server's value, recomputed from the writes: the current time of
  // every live session and the last-used stamp.
  const current = new Map<string, number | null>()
  for (const write of writes) {
    const id = write.kind === 'session' ? write.sessionId : `workspace:${workspaceId}`
    if (write.kind === 'session' && write.op === 'delete') current.delete(id)
    else current.set(id, write.new)
  }
  const max = Math.max(...[...current.values()].map((value) => value ?? Number.NEGATIVE_INFINITY))
  if (ms(server) !== max) {
    return unexplained(`the server's ${String(server)} is not what the audited writes add up to`)
  }
  const heldMs = ms(held)
  if (!(heldMs < max)) return unexplained('the client does not hold an older value')

  const sockets = socketsOf(p, wire)
  for (const event of events(p)) {
    const value =
      event.name === 'workspace.updated' && event.workspaceId === workspaceId
        ? ms(event.lastActivityAt)
        : event.name === 'session.created' && event.workspaceId === workspaceId
          ? event.ts
          : undefined
    if (value !== undefined && value > heldMs) {
      return unexplained(
        `${event.name} (#${event.sequence}) announced ${iso(value)} to every client: a lost update`,
      )
    }
    if (
      TURN_EVENTS.has(event.name) &&
      event.sessionId &&
      inWorkspace.has(event.sessionId) &&
      event.ts > heldMs
    ) {
      const offered = offeredAsEvent(p, wire, sockets, event)
      if (offered) {
        return unexplained(
          `${event.name} (${event.scopeKey} #${event.sequence}, ${iso(event.ts)}) was ${offered}: a lost update`,
        )
      }
    }
  }
  for (const delivery of carried(p, sockets)) {
    const values = [
      delivery.workspaces[workspaceId],
      delivery.announced?.workspaceId === workspaceId ? delivery.announced.at : undefined,
    ]
    for (const value of values) {
      if (typeof value === 'string' && ms(value) > heldMs) {
        return unexplained(
          `a response handed socket ${delivery.s} ${value}, and the client lost it`,
        )
      }
    }
  }

  const booted = bootSeqs(p)
  const all = events(p)
  const classOf = (write: SessionWrite | WorkspaceWrite): string | undefined => {
    if (write.kind === 'workspace') return undefined
    const value = write.new!
    // A projected write: some event of this session carries its time (the
    // projection writes the event's own timestamp), but none the client's
    // recency rule reads reached it (checked above). X1's mechanism.
    if (all.some((event) => event.sessionId === write.sessionId && event.ts === value)) {
      return 'WORKSPACE_RECENCY_MIRROR'
    }
    const kind = silentKind(p, write, booted)
    return kind === 'stamp'
      ? 'RUNTIME_STAMP_RECENCY'
      : kind === 'recovery'
        ? 'SILENT_RECOVERY'
        : undefined
  }
  const above = writes.filter(
    (write) => !(write.kind === 'session' && write.op === 'delete') && write.new! > heldMs,
  )
  for (const write of above) {
    if (classOf(write) === undefined) {
      return unexplained(
        `the ${write.kind} write to ${iso(write.new!)} (audit #${write.seq}) is announced by nothing and is no known silent write`,
      )
    }
  }
  const deciding = above[lastIndex(above, (write) => write.new === max)]!
  return {
    cause: classOf(deciding)!,
    because: `audit #${deciding.seq} wrote ${iso(max)}; nothing offered the client a value above ${String(held)}`,
  }
}
