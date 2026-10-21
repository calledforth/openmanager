import type { IncomingMessage } from 'node:http'
import type { ErrorCode } from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'

export interface RequestRejection {
  status: number
  code: ErrorCode
  message: string
}

/**
 * True when `origin` names exactly the host the request was sent to. A web
 * page only ever sends its own origin, so no page on another site can produce
 * this one; it comes from a page this host served itself, or from a native
 * WebSocket client that fills `Origin` in from the URL it dials (React
 * Native does, on Android and iOS). `host` has already passed the `Host`
 * check, so this admits nothing the host list does not.
 */
function isSameOrigin(origin: string, host: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.origin === origin.toLowerCase() && url.host === host
}

/**
 * Host and Origin policy shared by HTTP requests and WebSocket upgrades
 * (threat model T8, T9). Both checks fail closed: a request whose `Host` is
 * not the bound loopback address or a configured host is refused, which is
 * what defeats DNS rebinding, and a request carrying an `Origin` that is
 * neither allowlisted nor the request's own host is refused even with a valid
 * credential. Forwarded headers are never consulted, so a proxy cannot vouch
 * for a hostname it was not configured for.
 */
export function createRequestGuard(options: {
  allowedOrigins: readonly string[]
  allowedHosts: readonly string[]
  /** The bound port, known only after listen. */
  port: () => number
  audit: AuditLog
}) {
  const loopbackHosts = () => {
    const port = options.port()
    return [`127.0.0.1:${port}`, `localhost:${port}`]
  }
  return {
    /** `undefined` when the request may proceed. */
    check(request: IncomingMessage): RequestRejection | undefined {
      const remoteAddress = request.socket.remoteAddress
      const path = request.url?.split('?')[0]
      const command = auditValue(`${request.method ?? 'GET'} ${path ?? '/'}`)
      const host = request.headers.host?.trim().toLowerCase()
      if (
        host === undefined ||
        (!loopbackHosts().includes(host) && !options.allowedHosts.includes(host))
      ) {
        options.audit.record({
          type: 'host.rejected',
          remoteAddress,
          command: typeof command === 'string' ? command : undefined,
          details: { host: auditValue(host), url: auditValue(request.url) },
        })
        return { status: 403, code: 'auth', message: 'Host is not allowed.' }
      }
      const origin = request.headers.origin
      if (
        origin !== undefined &&
        !options.allowedOrigins.includes(origin) &&
        !isSameOrigin(origin, host)
      ) {
        options.audit.record({
          type: 'origin.rejected',
          remoteAddress,
          command: typeof command === 'string' ? command : undefined,
          details: { origin: auditValue(origin), url: auditValue(request.url) },
        })
        return { status: 403, code: 'auth', message: 'Origin is not allowed.' }
      }
      return undefined
    },
  }
}

export type RequestGuard = ReturnType<typeof createRequestGuard>
