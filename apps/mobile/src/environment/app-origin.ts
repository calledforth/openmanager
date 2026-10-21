import type { WebSocketConstructor, WebSocketLike } from '@openmanager/environment-client'
import { parsePairingLink } from '@openmanager/environment-client'
import type { RegistryStorage } from '@openmanager/environment-client/connection'

/**
 * The app origin: where the web app that made an environment's pairing link
 * is served (`https://app.example.com` for a link
 * `https://app.example.com/pair#…`). It is the value the environment's
 * `--allowed-origin` lists, so it is the `Origin` the phone's socket sends.
 *
 * React Native's WebSocket (OkHttp on Android, SocketRocket on iOS) otherwise
 * sends `Origin: http(s)://<host it dials>`, the route's own origin. The
 * environment refuses any `Origin` it was not told to allow, so through a
 * tunnel or on the LAN every upgrade would end in a 403 (a bare 1006 on the
 * phone) right after a bootstrap that answered.
 */

/** An http(s) origin, as `URL.origin` writes it; `null` for anything else. */
export function parseAppOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const origin = url.origin
  return origin && origin !== 'null' ? origin : null
}

/**
 * The app origin a pairing link was opened from: the origin of the link's
 * own URL. `null` for a bare fragment, which names no app.
 */
export function appOriginFromPairingLink(link: string): string | null {
  if (!parsePairingLink(link).ok) return null
  return parseAppOrigin(link)
}

/** The origin React Native sends on its own: the route's, from the URL it dials. */
export function routeOrigin(endpoint: string): string | null {
  return parseAppOrigin(endpoint)
}

/**
 * React Native's WebSocket constructor: the WHATWG one plus a third
 * `options` argument whose `headers.origin`, when present, replaces the
 * `Origin` the native module would derive from the URL.
 */
export type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocketLike

/**
 * `Base`, dialling with `Origin: origin`. The shared client calls it as a
 * WHATWG constructor, `(url, protocols)`; the header goes in React Native's
 * third argument. A subclass, so `instanceof` and the static ready states
 * still hold.
 */
export function withSocketOrigin(
  Base: NativeWebSocketConstructor,
  origin: string,
): WebSocketConstructor {
  const Native = Base as unknown as new (
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) => object
  class OriginWebSocket extends Native {
    constructor(url: string, protocols?: string[]) {
      super(url, protocols, { headers: { origin } })
    }
  }
  return OriginWebSocket as unknown as WebSocketConstructor
}

/**
 * Where the phone keeps each environment's app origin: its own document in
 * the registry store, beside the shared registry. The shared registry's
 * parser keeps only the fields the web app uses, so the phone's own field
 * cannot ride in it without changing shared code the web app also reads.
 */
export const PHONE_APP_ORIGINS_STORAGE_KEY = 'openmanager-phone-app-origins'
const APP_ORIGINS_VERSION = 1

export type AppOrigins = ReadonlyMap<string, string>

/** The saved app origins by environment ID. Anything unreadable is left out. */
export function readAppOrigins(storage: RegistryStorage): Map<string, string> {
  const origins = new Map<string, string>()
  let raw: string | null
  try {
    raw = storage.getItem(PHONE_APP_ORIGINS_STORAGE_KEY)
  } catch {
    return origins
  }
  if (!raw) return origins
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return origins
  }
  if (!document || typeof document !== 'object') return origins
  const entries = (document as { origins?: unknown }).origins
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return origins
  for (const [environmentId, value] of Object.entries(entries)) {
    const origin = parseAppOrigin(value)
    if (environmentId && origin) origins.set(environmentId, origin)
  }
  return origins
}

/** The document `readAppOrigins` reads, in a stable order. */
export function serializeAppOrigins(origins: AppOrigins): string {
  const sorted = [...origins].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return JSON.stringify({ version: APP_ORIGINS_VERSION, origins: Object.fromEntries(sorted) })
}
