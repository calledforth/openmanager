import { parsePairingLink, type PairingPayload } from '@openmanager/environment-client'

import { appOriginFromPairingLink } from '../environment/app-origin'
import type { PairingFailure } from './failures'

/**
 * A pairing link as the phone read it: the shared payload (route,
 * environment, token) and the app origin, the origin of the link's own URL,
 * which the phone's socket sends as `Origin` (`withSocketOrigin`). A bare
 * fragment names no app, so it has none; the controller then falls back to
 * the route's own origin and says so.
 *
 * The token is a secret until it is used: a read link lives in memory only,
 * for the length of one pairing.
 */
export type PairingLinkRead = { payload: PairingPayload; appOrigin: string | null }

/** Read what was scanned or pasted, with the shared parser. */
export function readPairingLink(
  text: string,
): { ok: true; link: PairingLinkRead } | { ok: false; failure: PairingFailure } {
  const input = text.trim()
  const parsed = parsePairingLink(input)
  if (!parsed.ok) return { ok: false, failure: { kind: 'link', problem: parsed.reason } }
  return { ok: true, link: { payload: parsed.payload, appOrigin: appOriginFromPairingLink(input) } }
}
