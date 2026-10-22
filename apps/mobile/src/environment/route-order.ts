import {
  isLoopbackEnvironmentEndpoint,
  parseEnvironmentEndpoint,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null
}

/**
 * True when the endpoint names an address on a local network: an RFC 1918
 * private or link-local IPv4 address, an IPv6 unique-local or link-local
 * address, or an mDNS / home-network name. A route like that is the
 * environment's machine on the same network as the phone, with no tunnel in
 * between. Carrier-grade NAT space (100.64/10, which Tailscale uses) is not
 * counted: it is an overlay network, not the room the phone is in.
 */
export function isLocalNetworkEndpoint(endpoint: string): boolean {
  const parsed = parseEnvironmentEndpoint(endpoint)
  if (!parsed) return false
  let host: string
  try {
    host = new URL(parsed).hostname.toLowerCase()
  } catch {
    return false
  }
  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1)
    return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)
  }
  return host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')
}

/**
 * The phone's search order: routes on this device or its local network
 * first, then the rest (tunnels, public hosts), each group in the person's
 * order. `searchRoutes` asks every route at once but only takes one after all
 * the routes ahead of it failed, so a LAN route that answers wins over a
 * tunnel that answered sooner. The record itself is not changed; only the
 * copy handed to the search is reordered.
 */
export function phoneSearchOrder(environment: StoredEnvironment): StoredEnvironment {
  const near = environment.routes.filter(
    (route) =>
      isLoopbackEnvironmentEndpoint(route.endpoint) || isLocalNetworkEndpoint(route.endpoint),
  )
  if (near.length === 0 || near.length === environment.routes.length) return environment
  return {
    ...environment,
    routes: [...near, ...environment.routes.filter((route) => !near.includes(route))],
  }
}
