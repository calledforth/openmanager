import type { IncomingMessage } from 'node:http'

export const LOCAL_OWNER_PATH = '/local-owner'

/**
 * Issuance of the already-minted owner credential, not authorization.
 * Threat model D2: network position grants nothing on remote routes. This
 * surface exists so the first-party localhost web shell can collect the
 * credential without QR pairing. It is not served for tunnel hosts, missing
 * origins, or any non-loopback origin — even when that origin is allowlisted.
 */
export type LocalOwnerAccess = 'ok' | 'not_found' | 'forbidden'

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function isLoopbackHostHeader(host: string | undefined, port: number): boolean {
  const normalized = host?.trim().toLowerCase()
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}`
  )
}

/** A first-party browser origin on loopback. Hosted and attacker origins fail. */
export function isFirstPartyLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Decide whether this request may receive the published owner credential.
 * Host/Origin allowlists still run first in the request guard. A tunnel Host
 * answers 404 so the route does not exist on remote names. Forwarded headers
 * are ignored here, as they are everywhere else.
 */
export function evaluateLocalOwnerAccess(
  request: IncomingMessage,
  port: number,
): LocalOwnerAccess {
  const host = request.headers.host
  if (!isLoopbackHostHeader(host, port) || !isLoopbackRemoteAddress(request.socket.remoteAddress)) {
    return 'not_found'
  }
  if (!isFirstPartyLoopbackOrigin(request.headers.origin)) return 'forbidden'
  return 'ok'
}
