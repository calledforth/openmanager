/**
 * The phone's new-session pages, by address, as the shared session state
 * reads them (`onLanding`, `landingDraftId`): `/draft/new` is the blank page,
 * `/draft/<id>` a draft's own page, which a blank page becomes with its first
 * text or image. Web's `/` and `/drafts/<id>`.
 */

/** The blank page's id segment: a draft's own id is a UUID, never this. */
export const BLANK_DRAFT = 'new'

const DRAFT_PREFIX = '/draft/'

export interface LandingRoute {
  /** A new-session page is in front. */
  onLanding: boolean
  /** The draft its address names; null on the blank page and off the landing. */
  draftId: string | null
}

const OFF: LandingRoute = { onLanding: false, draftId: null }

/** What the address in front says about the landing. */
export function landingOf(pathname: string): LandingRoute {
  if (!pathname.startsWith(DRAFT_PREFIX)) return OFF
  const segment = pathname.slice(DRAFT_PREFIX.length).replace(/\/+$/, '')
  if (!segment || segment.includes('/')) return OFF
  if (segment === BLANK_DRAFT) return { onLanding: true, draftId: null }
  let draftId: string
  try {
    draftId = decodeURIComponent(segment)
  } catch {
    return OFF
  }
  return { onLanding: true, draftId }
}

/** The address of a draft's page, or of the blank page for null. */
export function draftHref(draftId: string | null): `/draft/${string}` {
  return `/draft/${draftId === null ? BLANK_DRAFT : encodeURIComponent(draftId)}`
}

/** The address of a session's page. */
export function sessionHref(sessionId: string): `/session/${string}` {
  return `/session/${encodeURIComponent(sessionId)}`
}
