import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const LOCAL_OWNER_PATH = '/local-owner'
export const LOCAL_OWNER_CLAIM_HEADER = 'x-openmanager-local-owner'
export const LOCAL_OWNER_CLAIM_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Issuance of the already-minted owner credential, not authorization.
 * Threat model D2: network position grants nothing on remote routes. This
 * surface exists so the first-party localhost web shell can collect the
 * credential without QR pairing. A process-scoped claim key supplies the
 * proof that browser-controlled headers and socket metadata cannot.
 */
export type LocalOwnerAccess = 'ok' | 'not_found' | 'forbidden'

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Headers a tunnel or reverse proxy typically adds. Presence means this is
 * not a same-machine browser talking to the bound loopback listener, even
 * when `Host` was rewritten to `127.0.0.1` (threat model T2). They are never
 * used as identity — only as a reason to hide this issuance route.
 */
export const PROXY_FINGERPRINT_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
] as const

export function hasProxyFingerprint(headers: IncomingMessage['headers']): boolean {
  return PROXY_FINGERPRINT_HEADERS.some((name) => headers[name] !== undefined)
}

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
 * Decide whether the request reached the local-only route boundary. The claim
 * key is checked separately after Host/Origin allowlists run in the guard.
 */
export function evaluateLocalOwnerRouteAccess(
  request: IncomingMessage,
  port: number,
): LocalOwnerAccess {
  const host = request.headers.host
  if (
    !isLoopbackHostHeader(host, port) ||
    !isLoopbackRemoteAddress(request.socket.remoteAddress) ||
    hasProxyFingerprint(request.headers)
  ) {
    return 'not_found'
  }
  if (!isFirstPartyLoopbackOrigin(request.headers.origin)) return 'forbidden'
  return 'ok'
}

function claimKeysMatch(presented: string | string[] | undefined, expected: string | undefined) {
  if (
    typeof presented !== 'string' ||
    expected === undefined ||
    !LOCAL_OWNER_CLAIM_KEY_PATTERN.test(presented) ||
    !LOCAL_OWNER_CLAIM_KEY_PATTERN.test(expected)
  ) {
    return false
  }
  const candidate = Buffer.from(presented, 'utf8')
  const configured = Buffer.from(expected, 'utf8')
  return candidate.byteLength === configured.byteLength && timingSafeEqual(candidate, configured)
}

/**
 * The process-scoped claim key is supplied to the local web process out of
 * band. Host, Origin and socket address restrict the surface, but none of them
 * is proof of locality because an unmarked TCP tunnel can spoof all three.
 */
export function evaluateLocalOwnerAccess(
  request: IncomingMessage,
  port: number,
  claimKey: string | undefined,
): LocalOwnerAccess {
  const routeAccess = evaluateLocalOwnerRouteAccess(request, port)
  if (routeAccess !== 'ok') return routeAccess
  return claimKeysMatch(request.headers[LOCAL_OWNER_CLAIM_HEADER], claimKey)
    ? 'ok'
    : 'not_found'
}
