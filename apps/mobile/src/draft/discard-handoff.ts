/**
 * Discarding the draft on screen, the phone's way: the page goes back to the
 * sessions home first, and the discard is made once its draft is no longer
 * the one in front. Made while it still is, the shared discard would turn
 * the page into a blank new session (web's way, where the sidebar stays in
 * view); the phone's undo is on the home, beside the Drafts tab the draft
 * comes back to.
 *
 * Pure, so it is tested without React Native: `request` is the page's,
 * `settle` runs whenever what it waits on may have changed.
 */
import type { EnvironmentState } from '@openmanager/environment-client'

/**
 * Whether the page's draft is one the environment (or this phone, on its
 * way there) holds, and not being sent: a blank page has nothing to discard,
 * and a draft being sent is the send's.
 */
export function draftDiscardable(
  state: Pick<EnvironmentState, 'drafts' | 'draftEdits'>,
  draftId: string | null | undefined,
): boolean {
  if (!draftId) return false
  const edit = state.draftEdits[draftId]
  if (edit?.launching) return false
  return state.drafts[draftId] !== undefined || edit !== undefined
}

/** A draft, by its environment: ids are only unique within one. */
export type DraftRef = { environmentId: string; draftId: string }

export interface DiscardHandoff {
  /** Discard this draft once it is off screen. A later request replaces it. */
  request(draft: DraftRef): void
  /**
   * Make the waiting discard if it is this environment's and its draft is no
   * longer on screen. Null `discard` (an environment that keeps no drafts):
   * that environment's request is dropped. Another environment's waits for
   * that environment's own host.
   */
  settle(
    environmentId: string,
    onScreenDraftId: string | null,
    discard: ((draftId: string) => void) | null,
  ): void
  waiting(): DraftRef | null
  subscribe(listener: () => void): () => void
}

export function createDiscardHandoff(): DiscardHandoff {
  let waiting: DraftRef | null = null
  const listeners = new Set<() => void>()
  const set = (next: DraftRef | null) => {
    if (
      waiting === next ||
      (waiting &&
        next &&
        waiting.environmentId === next.environmentId &&
        waiting.draftId === next.draftId)
    ) {
      return
    }
    waiting = next
    for (const listener of [...listeners]) listener()
  }
  return {
    request: (draft) => set(draft),
    settle(environmentId, onScreenDraftId, discard) {
      const draft = waiting
      if (draft === null || draft.environmentId !== environmentId) return
      if (!discard) {
        set(null)
        return
      }
      if (onScreenDraftId === draft.draftId) return
      set(null)
      discard(draft.draftId)
    },
    waiting: () => waiting,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The app's one handoff, from a draft page to its environment's `DraftDiscardHost`. */
export const discardHandoff = createDiscardHandoff()
