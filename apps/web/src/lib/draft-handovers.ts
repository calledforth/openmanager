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
 * from, until it is settled which of the two stays.
 *
 * - `moving`: the copy's page is on its way to the screen.
 * - `landed`: the user went to the copy. The original goes once the copy is
 *   saved there, if it still says what was copied and has no images.
 * - `left`: the user went elsewhere first. The copy goes once it is saved
 *   there, if neither it nor the original has changed.
 */
export interface DraftHandover {
  /** Where the copy went. */
  environmentId: string
  copy: { draftId: string; sessionId: string }
  /** The copy's address. */
  arrival: string
  left: LeftDraft
  stage: 'moving' | 'landed' | 'left'
}

/**
 * Kept in this browser so a reload or a closed tab does not leave both
 * copies. Only `moving` and `landed` handovers are kept: either one, picked
 * up by another tab, only ever deletes the original, as this tab's would. A
 * `left` one would delete the copy, which another tab may since have gone to,
 * so it lives only in the tab that made it.
 */
export const DRAFT_HANDOVERS_KEY = 'openmanager.draft-handovers'

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
    (item.stage === 'moving' || item.stage === 'landed') &&
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

/** Kept, or forgotten if it is `left`. Read and written whole, so other tabs' stay. */
export function keepDraftHandover(handover: DraftHandover) {
  const others = read().filter((item) => item.copy.draftId !== handover.copy.draftId)
  write(handover.stage === 'left' ? others : [...others, handover])
}

export function forgetDraftHandover(copyDraftId: string) {
  const handovers = read()
  const rest = handovers.filter((item) => item.copy.draftId !== copyDraftId)
  if (rest.length !== handovers.length) write(rest)
}

/**
 * The handovers a page left unsettled, picked up as it loads at `pathname`.
 * One whose copy's page was still on its way has landed if this is that page;
 * anywhere else, it is forgotten and both copies stay.
 */
export function resumeDraftHandovers(pathname: string): DraftHandover[] {
  const kept = read()
  const resumed = kept.flatMap((handover): DraftHandover[] => {
    if (handover.stage !== 'moving') return [handover]
    return handover.arrival === pathname ? [{ ...handover, stage: 'landed' }] : []
  })
  if (resumed.length !== kept.length || resumed.some((item, index) => item !== kept[index])) {
    write(resumed)
  }
  return resumed
}
