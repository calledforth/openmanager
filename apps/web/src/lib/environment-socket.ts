/**
 * Derive the environment's WebSocket URL from its HTTP endpoint. The bootstrap
 * payload also advertises one, but it reports the loopback address the server
 * bound to, which is wrong the moment the browser reaches it through a tunnel.
 */
export function environmentSocketUrl(endpoint: string): string {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`
  const url = new URL('ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
