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
 * move it, so the move always finishes, wherever the page goes meanwhile: the
 * original goes once the copy is saved there, if it still says exactly what
 * was copied and has no images. The copy is never deleted here.
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
 * Kept in this browser so a reload or a closed tab does not leave both
 * copies. Any tab that picks one up does only what the tab that made it
 * would: delete the original, on the same checks.
 */
export const DRAFT_HANDOVERS_KEY = 'openmanager.draft-handovers'

/**
 * How long a handover is kept. One still unsettled after a day, its
 * environments away all that time, is let go: both copies stay.
 */
export const DRAFT_HANDOVER_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Not yet too old to act on. */
export function isFreshDraftHandover(handover: DraftHandover, now = Date.now()) {
  return now - handover.createdAt <= DRAFT_HANDOVER_MAX_AGE_MS
}

/** More than any one person moves at a time; the oldest go first. */
const KEPT = 32

function isHandover(value: unknown): value is DraftHandover {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<DraftHandover>
  const left = item.left as Partial<LeftDraft> | undefined
  return (
    typeof item.environmentId === 'string' &&
    typeof item.copy?.draftId === 'string' &&
    typeof item.copy.sessionId === 'string' &&
    typeof item.arrival === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof left?.draftId === 'string' &&
    typeof left.environmentId === 'string' &&
    typeof left.revision === 'number' &&
    typeof left.text === 'string' &&
    typeof left.images === 'number'
  )
}

function read(): DraftHandover[] {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_HANDOVERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { version?: unknown; handovers?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.handovers)) return []
    return parsed.handovers.filter(isHandover)
  } catch {
    return []
  }
}

function write(handovers: readonly DraftHandover[]) {
  try {
    if (handovers.length === 0) {
      globalThis.localStorage?.removeItem(DRAFT_HANDOVERS_KEY)
      return
    }
    globalThis.localStorage?.setItem(
      DRAFT_HANDOVERS_KEY,
      JSON.stringify({ version: 1, handovers: handovers.slice(-KEPT) }),
    )
  } catch {
    // Storage full or blocked: this tab still settles its own, and a reload
    // leaves both copies, which loses nothing.
  }
}

/** Read and written whole, so other tabs' handovers stay. */
export function keepDraftHandover(handover: DraftHandover) {
  const others = read().filter((item) => item.copy.draftId !== handover.copy.draftId)
  write([...others, handover])
}

export function forgetDraftHandover(copyDraftId: string) {
  const handovers = read()
  const rest = handovers.filter((item) => item.copy.draftId !== copyDraftId)
  if (rest.length !== handovers.length) write(rest)
}

/** The handovers a page left unsettled, picked up as it loads. Old ones are let go. */
export function resumeDraftHandovers(now = Date.now()): DraftHandover[] {
  const kept = read()
  const fresh = kept.filter((handover) => isFreshDraftHandover(handover, now))
  if (fresh.length !== kept.length) write(fresh)
  return fresh
}
