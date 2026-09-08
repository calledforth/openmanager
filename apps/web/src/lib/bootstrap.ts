import {
  evaluateBootstrap,
  PROTOCOL_VERSION,
  type BootstrapResponse,
} from '@openmanager/protocol'
import type { BootstrapOutcome } from './connection-state'
import { environmentBootstrapUrl } from './environment-store'

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
    }
  }
}

function readOptionalLabel(bootstrap: BootstrapResponse): string | undefined {
  return typeof bootstrap.label === 'string' && bootstrap.label.trim() ? bootstrap.label : undefined
}

export async function fetchBootstrap(endpoint: string): Promise<BootstrapOutcome> {
  let response: Response
  try {
    // Discovery is unauthenticated. Do not send the stored client token here:
    // Authorization would force a CORS preflight, and GET /bootstrap does not
    // require a credential (the token is for the later WebSocket upgrade).
    response = await fetch(bootstrapUrl(endpoint), {
      headers: { accept: 'application/json' },
    })
  } catch {
    return {
      status: 'unreachable',
      message: `Could not reach ${endpoint}. Check that the environment server is running, then retry.`,
    }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    if (response.status === 401 || response.status === 403) {
      return interpretBootstrapResponse({ ok: false, status: response.status, body: null })
    }
    return {
      status: 'unreachable',
      message: 'The environment responded, but the bootstrap payload was not valid.',
    }
  }

  return interpretBootstrapResponse({
    ok: response.ok,
    status: response.status,
    body,
  })
}

export { PROTOCOL_VERSION }
