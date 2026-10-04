import {
  CLIENT_LABEL_MAX_LENGTH,
  PAIRING_EXCHANGE_PATH,
  PairingExchangeResponseSchema,
  PairingRejectionReasonSchema,
  type PairingExchangeResponse,
  type PairingRejectionReason,
} from '@openmanager/protocol'
import { isEnvironmentClientError } from '@openmanager/environment-client'
import { isLoopbackEnvironmentEndpoint } from './environment-store'

/** What a person reads when the environment refused a pairing link, by reason. */
const REJECTION_MESSAGES: Record<PairingRejectionReason, string> = {
  malformed: 'The environment could not read this pairing request.',
  invalid: 'This pairing link is not valid. It may have been withdrawn; ask for a new one.',
  expired: 'This pairing link expired. Ask for a new one; links last five minutes.',
  used: 'This pairing link was already used. Ask for a new one.',
  creator_revoked: 'The device that made this link no longer has access, so the link is void.',
  grant_exceeds_link: 'This asked for more access than the link offers.',
  already_authorized: 'This browser already has full access to the environment.',
}

export function pairingRejectionMessage(reason: PairingRejectionReason): string {
  return REJECTION_MESSAGES[reason]
}

function reasonIn(details: unknown): PairingRejectionReason | undefined {
  if (!details || typeof details !== 'object') return undefined
  const parsed = PairingRejectionReasonSchema.safeParse((details as { reason?: unknown }).reason)
  return parsed.success ? parsed.data : undefined
}

/** The refusal's reason, when an error is a pairing refusal. */
export function pairingRejectionReason(error: unknown): PairingRejectionReason | undefined {
  if (error instanceof PairingExchangeError) return error.reason
  return isEnvironmentClientError(error) ? reasonIn(error.details) : undefined
}

export class PairingExchangeError extends Error {
  readonly reason: PairingRejectionReason | undefined

  constructor(message: string, reason?: PairingRejectionReason) {
    super(message)
    this.name = 'PairingExchangeError'
    this.reason = reason
  }
}

/** Join `/pair` onto a route, keeping any path prefix it has. */
export function pairingExchangeUrl(route: string): string {
  return new URL(PAIRING_EXCHANGE_PATH.slice(1), route.endsWith('/') ? route : `${route}/`).href
}

/**
 * Trade a pairing token for this browser's own credential at `POST /pair` on
 * the link's route. Only for a browser that holds no credential for the
 * environment: the body never carries one, since the route came from a link
 * and a link can point anywhere.
 */
export async function exchangePairingToken(
  route: string,
  input: { token: string; label?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PairingExchangeResponse> {
  let response: Response
  try {
    response = await fetchImpl(pairingExchangeUrl(route), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        input.label ? { token: input.token, label: input.label } : { token: input.token },
      ),
      // The answer carries a credential; nothing in between should keep it.
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch {
    throw new PairingExchangeError(
      `Could not reach ${route}. Check that this device can reach the environment at that address.`,
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    const reason = reasonIn(
      error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined,
    )
    if (reason) throw new PairingExchangeError(pairingRejectionMessage(reason), reason)
    if (response.status === 429) {
      throw new PairingExchangeError('Too many pairing attempts. Wait a minute and try again.')
    }
    if (response.status === 404 || response.status === 405) {
      throw new PairingExchangeError(
        'The address in this link does not pair devices. The environment may need updating.',
      )
    }
    throw new PairingExchangeError(`The environment answered with HTTP ${response.status}.`)
  }
  const parsed = PairingExchangeResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new PairingExchangeError('The environment answered with something that is not a pairing.')
  }
  return parsed.data
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

/** A name the device suggests for itself, such as "Chrome on Android". */
export function suggestDeviceLabel(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const label =
    browser && platform ? `${browser} on ${platform}` : (browser ?? platform ?? 'Web browser')
  return label.slice(0, CLIENT_LABEL_MAX_LENGTH)
}

/**
 * Where this web app is served from: the address a pairing link opens. A
 * phone can only open it when it is not this computer's loopback address.
 */
export function pairingAppUrl(location: Pick<Location, 'origin'> = window.location): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href
}

export function isLoopbackAppUrl(appUrl: string): boolean {
  return isLoopbackEnvironmentEndpoint(appUrl)
}
