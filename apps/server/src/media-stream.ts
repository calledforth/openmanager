import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * How long a stream grant answers. Long enough that a paused video still seeks
 * after a coffee; a player that outlives it asks for another.
 */
export const MEDIA_GRANT_TTL_MS = 60 * 60_000
/** Grants one client may hold at once; the oldest goes first. */
export const MEDIA_GRANTS_PER_CLIENT = 64

export type MediaGrant = {
  clientId: string
  sessionId: string
  artifactId: string
  expiresAt: number
}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Bearer grants for media players, which send no headers. A grant is 256
 * random bits in the URL path, kept only as a digest, scoped to one artifact
 * for one client, and dropped when that client is revoked. Memory only: a
 * restart ends them all and players ask again, which fails safe.
 */
export function createMediaGrants(options: { clock?: () => number; ttlMs?: number } = {}) {
  const clock = options.clock ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? MEDIA_GRANT_TTL_MS
  const grants = new Map<string, MediaGrant>()

  const prune = () => {
    const now = clock()
    for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key)
  }

  return {
    mint(scope: Omit<MediaGrant, 'expiresAt'>) {
      prune()
      const held = [...grants].filter(([, grant]) => grant.clientId === scope.clientId)
      // Insertion order is age order, so the first ones are the oldest.
      for (const [key] of held.slice(0, Math.max(0, held.length - MEDIA_GRANTS_PER_CLIENT + 1))) {
        grants.delete(key)
      }
      const token = randomBytes(32).toString('base64url')
      const expiresAt = clock() + ttlMs
      grants.set(digest(token), { ...scope, expiresAt })
      return { token, expiresAt }
    },
    lookup(token: string): MediaGrant | undefined {
      const key = digest(token)
      const grant = grants.get(key)
      if (!grant) return undefined
      if (grant.expiresAt <= clock()) {
        grants.delete(key)
        return undefined
      }
      return grant
    },
    revokeClient(clientId: string) {
      for (const [key, grant] of grants) if (grant.clientId === clientId) grants.delete(key)
    },
    get size() {
      prune()
      return grants.size
    },
  }
}
export type MediaGrants = ReturnType<typeof createMediaGrants>

/**
 * The one byte range a `Range` header asks for, inclusive, or `unsatisfiable`.
 * Undefined means "send it all": no header, a unit other than bytes, or
 * several ranges, which a server may answer whole (RFC 9110 §14.2).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, first, last] = match
  if (first === '' && last === '') return undefined
  if (first === '') {
    // A suffix: the last N bytes.
    const length = Number(last)
    if (length === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * Send a stored file, whole or the one range asked for, from disk as it is
 * read: a video of hundreds of megabytes is never held in memory, and a
 * player seeks by asking for the range it needs.
 */
export function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: { path: string; sizeBytes: number; mimeType: string },
  headers: Record<string, string> = {},
) {
  const { sizeBytes } = file
  const range = parseRange(request.headers.range, sizeBytes)
  const common = {
    'accept-ranges': 'bytes',
    // Never cached: a browser keys its cache by URL, not credential.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  }
  if (range === 'unsatisfiable') {
    response.writeHead(416, { ...common, 'content-range': `bytes */${sizeBytes}` })
    response.end()
    return
  }
  const start = range?.start ?? 0
  const end = range?.end ?? sizeBytes - 1
  response.writeHead(range ? 206 : 200, {
    ...common,
    'content-type': file.mimeType,
    'content-length': String(end - start + 1),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${sizeBytes}` } : {}),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  const stream = createReadStream(file.path, { start, end })
  // A player drops a connection whenever it seeks; the read stops with it.
  response.on('close', () => stream.destroy())
  stream.on('error', () => response.destroy())
  stream.pipe(response)
}
