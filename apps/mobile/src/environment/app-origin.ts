import type { WebSocketConstructor, WebSocketLike } from '@openmanager/environment-client'
import { parsePairingLink } from '@openmanager/environment-client'
import { parseAppOrigin } from '@openmanager/environment-client/connection'

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
 *
 * It is kept on the environment's shared record (`StoredEnvironment.appOrigin`),
 * which the phone's storage carries in AsyncStorage as written; it is not a
 * secret.
 */

/** An http(s) origin, as `URL.origin` writes it; `null` for anything else. */
export { parseAppOrigin }

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
