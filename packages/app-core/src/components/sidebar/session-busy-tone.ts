/**
 * Which glyph a session's status earns, as data. Pure and import-free so the
 * phone (Metro, no DOM) reads the same mapping the web sidebar paints with;
 * `SessionBusyLoader` re-exports it for the web.
 */

/** The states that show a glyph; a session at rest shows its age instead. */
export type SessionBusyTone = 'working' | 'background' | 'question' | 'needs' | 'done' | 'error'

/** What the status alone does not say, when the host knows it. */
export type SessionBusyDetail = {
  /** The kind of request a waiting session is waiting on. */
  waitingOn?: string
  /** A running session kept going only by its background work. */
  inBackground?: boolean
}

/** The glyph a session status earns, or null when it is at rest and shows its age. */
export function sessionBusyTone(
  status: string,
  detail: SessionBusyDetail = {},
): SessionBusyTone | null {
  if (status === 'waiting') return detail.waitingOn === 'question' ? 'question' : 'needs'
  if (status === 'done') return 'done'
  if (status === 'error') return 'error'
  if (status === 'running') return detail.inBackground ? 'background' : 'working'
  if (status === 'busy') return 'working'
  // `ready` / `idle`: nothing is happening and nothing is unseen.
  return null
}
