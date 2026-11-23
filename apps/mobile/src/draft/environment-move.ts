/**
 * Moving a new session's page to another environment, as web's environment
 * choice does it (`apps/web/src/components/environment-choice.tsx`).
 *
 * A draft cannot be moved. Its images are stored on its environment and its
 * project and picks mean nothing on another, so its text starts a new draft
 * there, in the project last picked there. Every delete here is one the user
 * asked for, and only once nothing is lost by it:
 *
 * - The original goes once the copy is saved where it went, and only while it
 *   still says exactly what was copied, has no images, and nothing of its own
 *   is on its way. Written to since, here or on another device, it stays.
 * - A draft with images stays where it is; the notice says so.
 * - It goes on its own only soon after the choice. Later, another device may
 *   have written to it offline since, so both stay.
 * - A page with no text (picks alone, or whitespace) goes to the other
 *   environment's blank page; its draft goes once its page has gone, on the
 *   same terms.
 * - Where any of that cannot be known, both stay.
 *
 * Pure of React: the host (`DraftMoveHost`) hands it the phone's clients and
 * calls `check` whenever any of them, or the page in front, may have changed.
 */
import {
  selectDraftContent,
  selectDraftSyncStatus,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'

/** How long after the choice the original may go on its own (web's window). */
export const DRAFT_HANDOVER_WINDOW_MS = 5 * 60 * 1000

/** The draft a choice left, as it was when its text was copied. */
export interface LeftDraft {
  draftId: string
  environmentId: string
  /** What was copied. The original goes only while it still says exactly this. */
  text: string
  /** Attached, or on their way in: either way they cannot go along. */
  images: number
}

/** A draft's text copied to another environment, until it is settled. */
export interface DraftHandover {
  /** Where the copy went. */
  environmentId: string
  copy: { draftId: string; sessionId: string }
  left: LeftDraft
  createdAt: number
}

export interface MoveNotice {
  key: number
  message: string
}

/** What the mover reads of an environment's client. */
export type MoveClient = Pick<EnvironmentClient, 'getState' | 'subscribe' | 'supports' | 'drafts'>

export interface DraftMoverDeps {
  clientOf(environmentId: string): MoveClient | undefined
  /** Connected now, and not offline as far as the phone can tell. */
  reachable(environmentId: string): boolean
  labelOf(environmentId: string): string
  /** Where a new-session page of that environment opens: its last picked project, else its most recent. */
  landingWorkspaceOf(state: EnvironmentState): string | null
  /** Whether that environment still has this draft open on a page. */
  onScreen(environmentId: string, draftId: string): boolean
  /** Put the original's page in place of the copy's, which has nothing to show. */
  returnTo(environmentId: string, draftId: string): void
  mintId(): string
  now(): number
}

export type MoveResult =
  /** Not now: why, for the page to say (null when there is nothing worth saying). */
  | { kind: 'refused'; reason: string | null }
  /** Go to that environment's page: its draft's (`draftId`), or its blank one (null). */
  | { kind: 'moved'; environmentId: string; draftId: string | null }

/**
 * Connected, caught up and its drafts listed: what it says of its drafts is
 * the environment's, not a cache from before a reconnect.
 */
const listed = (state: EnvironmentState) =>
  state.connection.phase === 'connected' &&
  state.connection.caughtUp !== false &&
  state.draftsListed

/** Saved where it went, with nothing of its own on its way, or sent from there already. */
const copyArrived = (state: EnvironmentState, copy: DraftHandover['copy']) =>
  state.sessions[copy.sessionId] !== undefined ||
  (state.drafts[copy.draftId] !== undefined &&
    selectDraftSyncStatus(state, copy.draftId) === 'synced')

/**
 * Whether a draft still says exactly `text`, with no images and none on the
 * way in, and if so whether a save of its own is still on its way. Unchanged
 * with nothing waiting, it carries the revision a discard of it may name.
 */
export function standingOf(
  client: MoveClient,
  draftId: string,
  text: string,
): 'gone' | 'changed' | 'waiting' | { revision: number } {
  const state = client.getState()
  const content = selectDraftContent(state, draftId)
  if (!content) return 'gone'
  if (
    content.text !== text ||
    content.artifactIds?.length ||
    client.drafts?.holdsImage?.(draftId)
  ) {
    return 'changed'
  }
  if (state.draftEdits[draftId]) return 'waiting'
  const revision = state.drafts[draftId]?.revision
  return revision === undefined ? 'gone' : { revision }
}

export function createDraftMover(deps: DraftMoverDeps) {
  let handovers: DraftHandover[] = []
  /** Drafts with nothing to copy, waiting for their page to go before they do. */
  let leftovers: Array<LeftDraft & { createdAt: number }> = []
  let notice: MoveNotice | null = null
  let noticeKey = 0
  const listeners = new Set<() => void>()
  const watching = new Map<MoveClient, () => void>()

  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  const tell = (message: string) => {
    noticeKey += 1
    notice = { key: noticeKey, message }
    emit()
  }
  const recent = (createdAt: number) => deps.now() - createdAt <= DRAFT_HANDOVER_WINDOW_MS

  /** Listen to every client a handover or a leftover waits on, and to no other. */
  const rewatch = () => {
    const wanted = new Set<MoveClient>()
    const add = (environmentId: string) => {
      const client = deps.clientOf(environmentId)
      if (client) wanted.add(client)
    }
    for (const handover of handovers) {
      add(handover.environmentId)
      add(handover.left.environmentId)
    }
    for (const left of leftovers) add(left.environmentId)
    for (const [client, stop] of watching) {
      if (wanted.has(client)) continue
      stop()
      watching.delete(client)
    }
    for (const client of wanted) {
      if (!watching.has(client))
        watching.set(
          client,
          client.subscribe(() => check()),
        )
    }
  }

  const settleHandover = (handover: DraftHandover): boolean => {
    const target = deps.clientOf(handover.environmentId)
    const source = deps.clientOf(handover.left.environmentId)
    if (!target || !source) return false
    const { copy, left } = handover
    const there = deps.labelOf(handover.environmentId)
    const here = deps.labelOf(left.environmentId)
    const state = target.getState()
    // Never saved there, and too long to be: both stay.
    if (
      state.drafts[copy.draftId] === undefined &&
      state.draftEdits[copy.draftId]?.stalled === 'too_large' &&
      listed(state)
    ) {
      tell(`This draft is too long to save on ${there}. The original on ${here} was kept`)
      return true
    }
    if (!listed(state)) return false
    if (!copyArrived(state, copy)) {
      if (selectDraftContent(state, copy.draftId) !== undefined) return false
      // Refused there, deleted before it was saved, or never got there: the
      // original is all there is, and it stays.
      if (state.draftTombstones[copy.draftId] !== undefined) return true
      if (selectDraftContent(source.getState(), left.draftId) === undefined) return true
      // Its page went with it, as web's does: back to the draft it was copied from.
      if (deps.onScreen(handover.environmentId, copy.draftId)) {
        deps.returnTo(left.environmentId, left.draftId)
      }
      tell(`The copy on ${there} wasn't saved. The draft is still on ${here}`)
      return true
    }
    // Its images stayed with it, and so does it.
    if (left.images > 0) return true
    if (!listed(source.getState())) return false
    const standing = standingOf(source, left.draftId, left.text)
    if (standing === 'waiting') return false
    // Past the window another device may have written to it offline: it stays.
    if (typeof standing === 'object' && recent(handover.createdAt)) {
      source.drafts?.discard(left.draftId, { ifRevision: standing.revision })
    }
    return true
  }

  const settleLeftover = (left: LeftDraft & { createdAt: number }): boolean => {
    const source = deps.clientOf(left.environmentId)
    if (!source) return true
    if (!recent(left.createdAt)) return true
    // The page that held it goes first: discarded while on screen, the shared
    // state would turn that page into a blank one under the move.
    if (deps.onScreen(left.environmentId, left.draftId)) return false
    if (!listed(source.getState())) return false
    const standing = standingOf(source, left.draftId, left.text)
    if (standing === 'waiting') return false
    if (typeof standing === 'object') {
      source.drafts?.discard(left.draftId, { ifRevision: standing.revision })
    }
    return true
  }

  let checking = false
  function check() {
    // A discard below tells its client's listeners at once, this among them.
    if (checking) return
    checking = true
    try {
      const handoversBefore = handovers
      const leftoversBefore = leftovers
      handovers = handovers.filter((handover) => !settleHandover(handover))
      leftovers = leftovers.filter((left) => !settleLeftover(left))
      if (handovers !== handoversBefore || leftovers !== leftoversBefore) rewatch()
    } finally {
      checking = false
    }
  }

  const isFrom = (
    draft: { draftId: string; environmentId: string },
    from: { draftId: string; environmentId: string },
  ) => draft.draftId === from.draftId && draft.environmentId === from.environmentId

  return {
    /**
     * Go to `environmentId`'s new-session page with the draft `from` (the
     * page's own, if it has one): its text in a new draft there, or that
     * environment's blank page when it has none.
     */
    choose(
      environmentId: string,
      from: { draftId: string; environmentId: string } | null,
    ): MoveResult {
      const target = deps.clientOf(environmentId)
      if (from?.environmentId === environmentId) return { kind: 'refused', reason: null }
      if (!target || !deps.reachable(environmentId)) {
        return {
          kind: 'refused',
          reason: `${deps.labelOf(environmentId)} isn't connected. Try again once it is`,
        }
      }
      if (from) {
        const copying = handovers.find(
          (handover) => isFrom(handover.left, from) && recent(handover.createdAt),
        )
        if (copying) {
          return {
            kind: 'refused',
            reason: `This draft is moving to ${deps.labelOf(copying.environmentId)}. The original goes once the copy is saved`,
          }
        }
      }
      const source = from ? deps.clientOf(from.environmentId) : undefined
      const state = source?.getState()
      // A draft being sent is the send's: it becomes a session where it was written.
      if (from && state?.draftEdits[from.draftId]?.launching) {
        return { kind: 'refused', reason: 'This draft is being sent' }
      }
      const content = from && state ? selectDraftContent(state, from.draftId) : undefined
      const left: LeftDraft | null =
        from && content
          ? {
              draftId: from.draftId,
              environmentId: from.environmentId,
              text: content.text,
              images:
                (content.artifactIds?.length ?? 0) +
                (source?.drafts?.holdsImage?.(from.draftId) ? 1 : 0),
            }
          : null
      const here = from ? deps.labelOf(from.environmentId) : ''
      const there = deps.labelOf(environmentId)

      // Somewhere that keeps drafts: anywhere else, the text stays where it is.
      if (left?.text.trim() && target.drafts && target.supports('saveDraft')) {
        const copy = { draftId: deps.mintId(), sessionId: deps.mintId() }
        target.drafts.edit(
          copy.draftId,
          {
            type: 'new_session',
            workspaceId: deps.landingWorkspaceOf(target.getState()),
            sessionId: copy.sessionId,
          },
          { text: left.text },
        )
        // Saved now rather than after the pause in typing: the original waits on it.
        void target.drafts.flush()
        handovers = [...handovers, { environmentId, copy, left, createdAt: deps.now() }]
        rewatch()
        if (left.images > 0) tell(`Its images stayed with the draft on ${here}`)
        return { kind: 'moved', environmentId, draftId: copy.draftId }
      }
      if (left) {
        if (left.images > 0) {
          tell(`The draft and its images stayed on ${here}`)
        } else if (left.text.trim()) {
          tell(`${there} doesn't keep drafts, so this one stayed on ${here}`)
        } else {
          // Picks alone, or whitespace: nothing in it to lose.
          leftovers = [...leftovers, { ...left, createdAt: deps.now() }]
          rewatch()
        }
      }
      return { kind: 'moved', environmentId, draftId: null }
    },
    /** Settle what can be settled now. */
    check,
    notice: () => notice,
    dismiss(key: number) {
      if (notice?.key !== key) return
      notice = null
      emit()
    },
    /** Tell the page something about a move (a refused one). */
    tell,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Stop listening to every client: the host is gone. What waits stays as it is. */
    dispose() {
      for (const stop of watching.values()) stop()
      watching.clear()
      listeners.clear()
    },
    /** What is still waiting, for the tests. */
    pending: () => ({ handovers, leftovers }),
  }
}

export type DraftMover = ReturnType<typeof createDraftMover>
