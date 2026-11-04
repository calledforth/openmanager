/** The draft on the page a choice of environment left, as it was when its text was copied. */
export interface LeftDraft {
  draftId: string
  environmentId: string
  /**
   * The revision the copy was made from. The old draft is deleted at the
   * revision it has once its own saves have landed, and only while it still
   * says exactly what was copied; this one stands in if it has no other.
   */
  revision: number
  /** What was copied. The old draft goes only while it still says exactly this. */
  text: string
  /** Attached, or on their way in: either way they cannot go along. */
  images: number
}

/**
 * A draft's text copied to another environment, and the draft it was copied
 * from, from the moment of the choice until it is settled. The user asked to
 * move it, so the move finishes wherever the page goes meanwhile: the
 * original goes once the copy is saved there, if it still says exactly what
 * was copied and has no images, and only while the choice is recent. The
 * copy is never deleted here.
 *
 * Held by the page only. A reload or a closed tab before it settles leaves
 * both copies, which loses nothing.
 */
export interface DraftHandover {
  /** Where the copy went. */
  environmentId: string
  copy: { draftId: string; sessionId: string }
  /** The copy's address. */
  arrival: string
  left: LeftDraft
  /** When the choice was made, in milliseconds since the epoch. */
  createdAt: number
}

/**
 * How long after the choice the original may go on its own. Later, another
 * device may have written to it offline since, and deleting it would drop
 * that edit when it is saved: past this, the original is only ever discarded
 * when the user says so.
 */
export const DRAFT_HANDOVER_WINDOW_MS = 5 * 60 * 1000

/** Still recent enough for the original to go on its own. */
export function isRecentDraftHandover(handover: DraftHandover, now = Date.now()) {
  return now - handover.createdAt <= DRAFT_HANDOVER_WINDOW_MS
}
