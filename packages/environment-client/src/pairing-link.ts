import { z } from 'zod'
import { EntityIdSchema, PairingTokenSchema } from '@openmanager/protocol'

/**
 * What a pairing link or QR code carries: where to reach the environment,
 * which environment should answer there, and the single-use token. The route
 * is any http(s) address the environment answers on (loopback, LAN, a
 * tunnel); the payload neither knows nor cares which kind it is.
 *
 * The token is the only secret, and it is not a credential: the device trades
 * it at `POST {route}/pair` for one. A pairing client should check that the
 * route's `/bootstrap` answers with `environmentId` before it does.
 */
export const PairingPayloadSchema = z.strictObject({
  route: z
    .string()
    .max(2048)
    .refine((value) => normalizePairingRoute(value) === value, 'Not a pairing route'),
  environmentId: EntityIdSchema,
  token: PairingTokenSchema,
})
export type PairingPayload = z.infer<typeof PairingPayloadSchema>

export const PAIRING_LINK_VERSION = '1'

/**
 * An http(s) URL with no credentials, query or fragment, as a canonical
 * string: origin plus path, without a trailing slash. `undefined` when the
 * input cannot be a route.
 */
export function normalizePairingRoute(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * The link a person opens on the new device: the web app's `pair` page with
 * the payload in the fragment, which browsers never send to the web host and
 * which the page strips from history after reading it.
 */
export function encodePairingLink(appUrl: string, payload: PairingPayload): string {
  const parsed = PairingPayloadSchema.parse(payload)
  const page = new URL('pair', appUrl.endsWith('/') ? appUrl : `${appUrl}/`)
  page.search = ''
  page.hash = new URLSearchParams({
    v: PAIRING_LINK_VERSION,
    route: parsed.route,
    environment: parsed.environmentId,
    token: parsed.token,
  }).toString()
  return page.href
}

/**
 * Read the payload back from a pairing link, or from its fragment alone.
 * `undefined` for anything that is not a well-formed version 1 link.
 */
export function parsePairingLink(link: string): PairingPayload | undefined {
  let fragment = link
  try {
    fragment = new URL(link).hash
  } catch {
    // Not a URL: treat the input as the fragment itself.
  }
  const params = new URLSearchParams(fragment.replace(/^#/, ''))
  if (params.get('v') !== PAIRING_LINK_VERSION) return undefined
  const parsed = PairingPayloadSchema.safeParse({
    route: params.get('route') ?? undefined,
    environmentId: params.get('environment') ?? undefined,
    token: params.get('token') ?? undefined,
  })
  return parsed.success ? parsed.data : undefined
}
