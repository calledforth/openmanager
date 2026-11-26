import { z } from 'zod'

/**
 * Updating the environment server from a client.
 *
 * This is an HTTP route, not a socket command, on purpose: it has to work when
 * the socket cannot. A client built for a newer protocol than the server it
 * talks to is refused at the handshake (negotiation.ts), and that is exactly
 * the client that most needs to say "this server is out of date" and update
 * it. So the route sits outside protocol negotiation, and its shapes must stay
 * readable by every client version: fields are only ever added, every object
 * keeps unknown fields, and nothing here is strict.
 *
 * - `GET  /server-update`          the update status (any paired client).
 *   `?check=1` asks GitHub for the newest release first.
 * - `POST /server-update`          start the update (`admin` clients only).
 *   Body `{ "version": "x.y.z" }` picks a version; empty takes the newest.
 *
 * Both take the client credential as `Authorization: Bearer <credential>`.
 * A server older than this route answers 404; a client then says to run
 * `openmanager update` on the machine.
 */
export const SERVER_UPDATE_PATH = '/server-update' as const

/** `x.y.z` or `x.y.z-pre`: the only shape server releases use. */
export const ServerVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected a version such as 0.22.0.')

/**
 * Where an update is, as the server sees it.
 *
 * - `idle`: nothing is running. `updatedFrom` says the last update finished
 *   by starting this server.
 * - `updating`: the updater is downloading, verifying, or moving the
 *   background service. The server stops and a new one starts on the same
 *   port during this state; a client sees its socket drop and come back.
 * - `failed`: the last attempt stopped; `error` says why. The server that
 *   answers is still the old one, unchanged.
 * - `restart_required`: the new version is installed, but this server was
 *   started by hand rather than as the background service, so nothing could
 *   restart it. Stop it and start `openmanager` again.
 */
export const ServerUpdateStateSchema = z.enum(['idle', 'updating', 'failed', 'restart_required'])

export const ServerUpdateStatusSchema = z.looseObject({
  /** The version of the server answering. */
  currentVersion: z.string(),
  /** The newest published server release, once it has been checked. */
  latestVersion: z.string().nullable(),
  /** `latestVersion` is newer than `currentVersion`. */
  updateAvailable: z.boolean(),
  /** When GitHub was last asked (ISO-8601), or null if never. */
  checkedAt: z.string().nullable(),
  /** Why the last check failed, when it did. */
  checkError: z.string().optional(),
  /** Whether this server can replace itself. A checkout or a moved copy cannot. */
  canUpdate: z.boolean(),
  /** Why not, in words a person can act on, when `canUpdate` is false. */
  cannotUpdateReason: z.string().optional(),
  state: ServerUpdateStateSchema.or(z.string()),
  /** The version being installed, or the one the last attempt was for. */
  targetVersion: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Why the last attempt failed. */
  error: z.string().optional(),
  /** The version this server replaced, when the last update started it. */
  updatedFrom: z.string().optional(),
  /** The release page of `latestVersion`. */
  releaseUrl: z.string().optional(),
})

export const ServerUpdateRequestSchema = z.looseObject({
  version: ServerVersionSchema.optional(),
})

export type ServerUpdateState = z.infer<typeof ServerUpdateStateSchema>
export type ServerUpdateStatus = z.infer<typeof ServerUpdateStatusSchema>
export type ServerUpdateRequest = z.infer<typeof ServerUpdateRequestSchema>

/** Semver-style comparison of `x.y.z[-pre]`: negative when `a` is older. */
export function compareServerVersions(a: string, b: string): number {
  const split = (version: string) => {
    const dash = version.indexOf('-')
    return {
      numbers: (dash === -1 ? version : version.slice(0, dash)).split('.').map(Number),
      pre: dash === -1 ? undefined : version.slice(dash + 1),
    }
  }
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < 3; index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre.localeCompare(right.pre, 'en', { numeric: true })
}
