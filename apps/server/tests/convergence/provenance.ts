import type { AuditRow, Delivery } from './child-protocol.ts'

/**
 * Write and event provenance: the server child's audit (SQLite triggers) and
 * delivery log, and which sockets are one client's. Scenarios read it to say
 * what the server wrote and owed a client, never from the client's state or
 * the views judged.
 *
 * Until F3 it also explained two time-valued causes by provenance (the
 * runtime stamp and the workspace recency mirror, a session's `updatedAt`
 * and a workspace's `lastActivityAt` moved by a write no event announced).
 * F3 announces every such write (§4.4, §4.7.1), so those explanations went
 * with their causes.
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
