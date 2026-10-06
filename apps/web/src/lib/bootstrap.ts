import {
  evaluateBootstrap,
  PROTOCOL_VERSION,
  type BootstrapResponse,
} from '@openmanager/protocol'
import type { BootstrapOutcome } from './connection-state'
import { environmentBootstrapUrl, isLoopbackEnvironmentEndpoint } from './environment-store'
import { loopbackAccessDenied } from './local-access'

export function bootstrapUrl(endpoint: string): string {
  return environmentBootstrapUrl(endpoint)
}

function readErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as { error?: { message?: unknown } }).error
  return typeof error?.message === 'string' && error.message.trim() ? error.message : undefined
}

function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as { error?: { code?: unknown } }).error
  return typeof error?.code === 'string' ? error.code : undefined
}

export function interpretBootstrapResponse(input: {
  ok: boolean
  status: number
  body: unknown
}): BootstrapOutcome {
  if (input.status === 401 || input.status === 403 || readErrorCode(input.body) === 'auth') {
    return {
      status: 'unauthorized',
      message:
        readErrorMessage(input.body) ??
        'The environment rejected this client. Update the credential or choose another environment.',
    }
  }

  if (!input.ok) {
    return {
      status: 'unreachable',
      message: `The environment server responded with HTTP ${input.status}.`,
      cause: 'http',
      httpStatus: input.status,
    }
  }

  try {
    const state = evaluateBootstrap(input.body)
    if (state.state === 'incompatible_protocol') {
      return {
        status: 'incompatible_protocol',
        clientProtocolVersion: state.clientProtocolVersion,
        serverProtocolVersion: state.serverProtocolVersion,
        environmentId: state.bootstrap.environmentId,
        label: readOptionalLabel(state.bootstrap),
      }
    }
    return {
      status: 'ready',
      environmentId: state.bootstrap.environmentId,
      label: readOptionalLabel(state.bootstrap),
      protocolVersion: state.bootstrap.protocolVersion,
    }
  } catch {
    return {
      status: 'unreachable',
      message: 'The environment responded, but the bootstrap payload was not valid.',
      cause: 'invalid',
    }
  }
}

function readOptionalLabel(bootstrap: BootstrapResponse): string | undefined {
  return typeof bootstrap.label === 'string' && bootstrap.label.trim() ? bootstrap.label : undefined
}

/**
 * After a bootstrap fetch failed, whether anything answered at all. A page may
 * only read a cross-origin answer that carries CORS headers, and the error
 * pages a gateway sends (Cloudflare's 530 for a tunnel that is down, its 502
 * for a tunnel whose server is not running) carry none, so the browser
 * reports them as the same network failure as silence. A `no-cors` request
 * gets an opaque answer instead: no status, but proof that something replied.
 * Not asked once the fetch has been cancelled or timed out.
 */
async function answersUnreadably(endpoint: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  try {
    const response = await fetch(bootstrapUrl(endpoint), {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal,
    })
    return response.type === 'opaque'
  } catch {
    return false
  }
}

export async function fetchBootstrap(
  endpoint: string,
  options: { signal?: AbortSignal } = {},
): Promise<BootstrapOutcome> {
  let response: Response
  try {
    // Discovery is unauthenticated. Do not send the stored client token here:
    // Authorization would force a CORS preflight, and GET /bootstrap does not
    // require a credential (the token is for the later WebSocket upgrade).
    response = await fetch(bootstrapUrl(endpoint), {
      headers: { accept: 'application/json' },
      signal: options.signal,
    })
  } catch {
    // A browser that refused this page access to its own loopback address
    // fails the fetch exactly as if nothing listened there. Its permission
    // state is the one place the difference shows.
    if (isLoopbackEnvironmentEndpoint(endpoint) && (await loopbackAccessDenied())) {
      return {
        status: 'unreachable',
        message: `This browser blocked this page from reaching ${endpoint} on this device.`,
        cause: 'blocked',
      }
    }
    return {
      status: 'unreachable',
      message: `Could not reach ${endpoint}. Check that the environment server is running, then retry.`,
      cause: (await answersUnreadably(endpoint, options.signal)) ? 'opaque' : 'network',
    }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A gateway in front of the environment (a tunnel, a proxy) answers its
    // own errors as HTML. The status is what says which side failed.
    if (!response.ok) {
      return interpretBootstrapResponse({ ok: false, status: response.status, body: null })
    }
    return {
      status: 'unreachable',
      message: 'The environment responded, but the bootstrap payload was not valid.',
      cause: 'invalid',
    }
  }

  return interpretBootstrapResponse({
    ok: response.ok,
    status: response.status,
    body,
  })
}

export { PROTOCOL_VERSION }
