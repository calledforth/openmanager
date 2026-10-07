import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { isLoopbackRemoteAddress } from './local-owner.ts'

/**
 * Who a failed-attempt budget (`auth_failure`, `pairing`, `tunnel_check`) is
 * kept for. Normally that is the socket's remote address. Behind the tunnel
 * every request arrives from `cloudflared` on loopback, so one remote device,
 * or a stranger who knows the hostname, would otherwise spend the budget of
 * every device and of the owner's own browser.
 *
 * A request counts as tunnel traffic only when it comes from loopback with
 * `Host` set to the configured tunnel hostname. Its budget is then keyed by
 * `CF-Connecting-IP`, which Cloudflare sets at its edge, IPv6 grouped by /64
 * so one network cannot mint keys; without a usable header it shares one
 * tunnel-wide bucket. Either way it is kept apart from local traffic.
 *
 * The header is used for this and nothing else: never as identity, never for
 * `/local-owner` (threat model D2, T2). A local process can forge it, which
 * gains it fresh budgets but no guess worth making: credentials and link
 * tokens are random.
 */
export type BudgetKey = (request: IncomingMessage) => string

export const remoteAddressKey: BudgetKey = (request) => request.socket.remoteAddress ?? 'unknown'

export function createBudgetKey(tunnelHostname: string | undefined): BudgetKey {
  if (tunnelHostname === undefined) return remoteAddressKey
  return (request) => {
    const remote = remoteAddressKey(request)
    if (!isLoopbackRemoteAddress(remote)) return remote
    if (request.headers.host?.trim().toLowerCase() !== tunnelHostname) return remote
    const forwarded = request.headers['cf-connecting-ip']
    const client = typeof forwarded === 'string' ? clientNetwork(forwarded.trim()) : undefined
    return client ? `tunnel:${client}` : 'tunnel:unknown'
  }
}

/** An IPv4 address as is; an IPv6 address as its /64 network. */
export function clientNetwork(address: string): string | undefined {
  const family = isIP(address)
  if (family === 4) return address
  if (family !== 6) return undefined
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped && isIP(mapped) === 4) return mapped
  const groups = expandIpv6(address)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : undefined
}

function expandIpv6(address: string): string[] | undefined {
  // An embedded IPv4 tail fills the last two groups.
  let text = address.toLowerCase().split('%')[0]!
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (tail) {
    const [a, b, c, d] = tail.split('.').map(Number)
    text = `${text.slice(0, -tail.length)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`
  }
  const [head, rest] = text.split('::')
  const left = head ? head.split(':') : []
  const right = rest !== undefined && rest.length > 0 ? rest.split(':') : []
  const fill = rest === undefined ? 0 : 8 - left.length - right.length
  if (fill < 0) return undefined
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right]
  if (groups.length !== 8) return undefined
  return groups.map((group) => (Number.parseInt(group || '0', 16) || 0).toString(16))
}
