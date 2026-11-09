/**
 * The phone's session and new-session pages, by address. Each names its
 * environment first: ids are only unique within one environment (a server
 * restored from a copy of another's data holds the same ones), so the
 * address says which environment's session or draft it is, and the page
 * opens through that environment alone.
 *
 * - `/session/<environment>/<session>`: a session's page.
 * - `/draft/<environment>/new`: the blank new-session page.
 * - `/draft/<environment>/<draft>`: a draft's own page, which a blank page
 *   becomes with its first text or image.
 *
 * Addresses from before environments were part of them (`/session/<id>`,
 * `/draft/<id>`) still open: their pages find the environment and move to
 * its address (`legacy-route.tsx`).
 *
 * The shared session state reads the new-session pages of its own
 * environment (`onLanding`, `landingDraftId`), as web reads `/` and
 * `/drafts/<id>`.
 */

/** The blank page's id segment: a draft's own id is a UUID, never this. */
export const BLANK_DRAFT = 'new'

export interface LandingRoute {
  /** A new-session page is in front. */
  onLanding: boolean
  /** The environment it is a new session of; null off the landing. */
  environmentId: string | null
  /** The draft its address names; null on the blank page and off the landing. */
  draftId: string | null
}

const OFF: LandingRoute = { onLanding: false, environmentId: null, draftId: null }

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** The segments after `/<prefix>/`, decoded; null for another address. */
function segmentsOf(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(`/${prefix}/`)) return null
  const rest = pathname.slice(prefix.length + 2).replace(/\/+$/, '')
  if (!rest) return null
  const segments = rest.split('/').map(decode)
  if (segments.some((segment) => !segment)) return null
  return segments as string[]
}

/** What the address in front says about the landing. */
export function landingOf(pathname: string): LandingRoute {
  const segments = segmentsOf(pathname, 'draft')
  if (!segments || segments.length !== 2) return OFF
  const [environmentId, draft] = segments as [string, string]
  return { onLanding: true, environmentId, draftId: draft === BLANK_DRAFT ? null : draft }
}

/** The landing as one environment's session state reads it: off unless it is that environment's. */
export function landingFor(landing: LandingRoute, environmentId: string): LandingRoute {
  return landing.environmentId === environmentId ? landing : OFF
}

/** The address of an environment's draft page, or of its blank page for null. */
export function draftHref(environmentId: string, draftId: string | null): `/draft/${string}` {
  const draft = draftId === null ? BLANK_DRAFT : encodeURIComponent(draftId)
  return `/draft/${encodeURIComponent(environmentId)}/${draft}`
}

/** The address of an environment's session page. */
export function sessionHref(environmentId: string, sessionId: string): `/session/${string}` {
  return `/session/${encodeURIComponent(environmentId)}/${encodeURIComponent(sessionId)}`
}

/** A session page's address, read: its environment (null for an old address) and session. */
export type SessionAddress = { environmentId: string | null; sessionId: string }

/** The session a phone path shows, if it shows one. */
export function sessionOnPath(pathname: string): SessionAddress | null {
  const segments = segmentsOf(pathname.replace(/[?#].*$/, ''), 'session')
  if (!segments) return null
  if (segments.length === 1) return { environmentId: null, sessionId: segments[0]! }
  if (segments.length === 2) return { environmentId: segments[0]!, sessionId: segments[1]! }
  return null
}

/** A row's environment, as the home tags it; absent on the fixture's rows. */
type Tagged = { environment?: { environmentId: string } }

/**
 * The page of a listed session, through its own environment. A row with no
 * environment (the fixture's) opens at its old address, which shows it.
 */
export function sessionRowHref(row: { externalId: string } & Tagged): string {
  return row.environment
    ? sessionHref(row.environment.environmentId, row.externalId)
    : `/session/${encodeURIComponent(row.externalId)}`
}

/** The page of a draft card, through its own environment; the fixture's at its old address. */
export function draftRowHref(row: { draftId: string } & Tagged): string {
  return row.environment
    ? draftHref(row.environment.environmentId, row.draftId)
    : `/draft/${encodeURIComponent(row.draftId)}`
}

/**
 * A blank new-session page, in the environment new sessions go to; at the
 * old address with none (the fixture), whose page says to pair first.
 */
export function newSessionHref(environmentId: string | null): string {
  return environmentId ? draftHref(environmentId, null) : `/draft/${BLANK_DRAFT}`
}
