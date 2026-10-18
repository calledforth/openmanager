/**
 * The pairing links this tab made, so one can be shown again after its
 * dialog closes. The environment sends a link's token once, to the client
 * that made it, and keeps only its hash: this is that client's own copy of
 * the result of its own action, nothing the environment could give back.
 *
 * It lives in `sessionStorage` (this tab only, through in-app navigation and
 * reloads, gone when the tab closes), never `localStorage`. An entry lasts no
 * longer than the environment honours the link: it is dropped once its
 * `expiresAt` passes, and forgotten as soon as the link is used or withdrawn.
 */

export const PAIRING_LINK_STORAGE_KEY = 'openmanager.pairing-links.v1'

/** A link this tab made: the URL it shows, and when the environment stops honouring it. */
export type MadePairingLink = {
  environmentId: string
  linkId: string
  url: string
  expiresAt: string
}

type LinkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function sessionStore(): LinkStorage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    // Storage can be switched off; a link then lives only while its dialog is open.
    return undefined
  }
}

function isEntry(value: unknown): value is MadePairingLink {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.environmentId === 'string' &&
    typeof entry.linkId === 'string' &&
    typeof entry.url === 'string' &&
    typeof entry.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(entry.expiresAt))
  )
}

const live = (entry: MadePairingLink, now: number) => Date.parse(entry.expiresAt) > now

const same = (entry: MadePairingLink, environmentId: string, linkId: string) =>
  entry.environmentId === environmentId && entry.linkId === linkId

function write(storage: LinkStorage, entries: readonly MadePairingLink[]) {
  try {
    if (entries.length === 0) storage.removeItem(PAIRING_LINK_STORAGE_KEY)
    else storage.setItem(PAIRING_LINK_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // A full or refused store only costs showing the link again.
  }
}

/** Every entry that has not expired. Expired or unreadable ones are pruned on the way. */
function read(storage: LinkStorage, now: number): MadePairingLink[] {
  let stored: unknown[]
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PAIRING_LINK_STORAGE_KEY) ?? '[]')
    stored = Array.isArray(parsed) ? parsed : [null]
  } catch {
    stored = [null]
  }
  const entries = stored.filter(isEntry).filter((entry) => live(entry, now))
  if (entries.length !== stored.length) write(storage, entries)
  return entries
}

/** Keep a link this tab just made. */
export function rememberPairingLink(
  entry: MadePairingLink,
  storage: LinkStorage | undefined = sessionStore(),
  now = Date.now(),
): void {
  if (!storage || !live(entry, now)) return
  const others = read(storage, now).filter((item) => !same(item, entry.environmentId, entry.linkId))
  write(storage, [...others, { ...entry }])
}

/** The links this tab made for an environment that have not expired, by link ID. */
export function madePairingLinks(
  environmentId: string,
  storage: LinkStorage | undefined = sessionStore(),
  now = Date.now(),
): ReadonlyMap<string, MadePairingLink> {
  if (!storage) return new Map()
  return new Map(
    read(storage, now)
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => [entry.linkId, entry]),
  )
}

/** Forget links that stopped working: used, withdrawn or void. */
export function forgetPairingLinks(
  environmentId: string,
  linkIds: readonly string[],
  storage: LinkStorage | undefined = sessionStore(),
  now = Date.now(),
): void {
  if (!storage || linkIds.length === 0) return
  const entries = read(storage, now)
  const kept = entries.filter(
    (entry) => !linkIds.some((linkId) => same(entry, environmentId, linkId)),
  )
  if (kept.length !== entries.length) write(storage, kept)
}
