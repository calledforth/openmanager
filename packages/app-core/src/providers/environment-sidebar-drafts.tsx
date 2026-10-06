import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { EnvironmentState } from '@openmanager/environment-client'
import {
  NO_DRAFT_FACTS,
  arrangeSidebarDrafts,
  sameSidebarDraftFacts,
  selectSidebarDrafts,
  sidebarDraftCard,
  type SidebarDraft,
} from '../components/sidebar/sidebar-sessions'
import { DraftPageNavigationContext } from './draft-pages'
import { useEnvironmentClient, useEnvironmentState } from './environment-client'
import { SessionStateContext } from './session-provider'
import {
  SidebarDraftsContext,
  type DraftDiscardOptions,
  type PendingDraftDiscard,
  type SidebarDraftsValue,
} from './sidebar-provider'

/** How long a discarded draft can still be brought back. */
export const DRAFT_DISCARD_UNDO_MS = 6_000

/** A discard waiting out its window, and the draft it was made on. */
interface WatchedDiscard {
  /**
   * The newest revision of the draft that is the user's own: the one they
   * discarded, or one this page wrote since (its last keystrokes, saved as
   * the discarded page closed). 0 for a draft never saved.
   */
  revision: number
  /** This page held an edit of it at the last look: a write of its own was due. */
  writing: boolean
}

/**
 * Whether a pending discard still deletes what the user discarded. It goes
 * by who wrote the draft's revisions, not by what they hold: a revision
 * another client wrote since (more text, another model, a restore after a
 * failed send) calls the discard off; one this page wrote never does,
 * whenever it lands. Nor does a gone draft (sent, or deleted elsewhere)
 * leave anything to delete.
 *
 * This page's writes are known by its edit: while the page holds one, every
 * revision that arrives is either its own or about to be overwritten by it
 * (saves are last-write-wins), and the revision the environment answers its
 * last write with is current the moment the edit settles. Call it on every
 * change, so that moment is seen.
 */
function discardStands(state: EnvironmentState, draftId: string, watched: WatchedDiscard) {
  const saved = state.drafts[draftId]
  const edit = state.draftEdits[draftId]
  if (edit?.launching) return false
  if (edit) {
    watched.writing = true
    return true
  }
  if (watched.writing) {
    watched.writing = false
    if (saved) watched.revision = Math.max(watched.revision, saved.revision)
  }
  return saved !== undefined && saved.revision <= watched.revision
}

/**
 * Whether an action names the discard waiting now. A notice on its way out
 * names its own: once another has taken its place, what it asks for is not
 * that one's to do. No key names whichever is waiting.
 */
function isCurrent(pending: PendingDraftDiscard | null, key: number | undefined) {
  return pending !== null && (key === undefined || pending.key === key)
}

/** The open draft's card, as it was when the draft was opened. */
interface FrozenCard {
  draftId: string | null
  card: SidebarDraft | null
}

/**
 * Serves the sidebar's draft cards from the environment's drafts. Hosts
 * without draft pages (or an environment that keeps no drafts) get null, and
 * the sidebar shows no cards.
 *
 * Nothing here changes while a draft is typed in: the cards are read with an
 * equality that ignores the draft on screen, whose card is the snapshot taken
 * when it was opened.
 */
export function EnvironmentSidebarDraftsProvider({ children }: { children: ReactNode }) {
  const client = useEnvironmentClient()
  const sync = client.drafts
  const navigation = useContext(DraftPageNavigationContext)
  const { newSessionDraftId, defaultProviderId } = useContext(SessionStateContext)!
  const enabled = navigation !== null && sync !== undefined
  const openDraftId = enabled ? (newSessionDraftId ?? null) : null

  // Taken during render, as the draft opens, so its card never drops out for
  // a frame. A draft that had a card keeps it, shown selected; one first
  // written on this page has none until it is left.
  const [frozen, setFrozen] = useState<FrozenCard>({ draftId: null, card: null })
  let shownFrozen = frozen
  if (frozen.draftId !== openDraftId) {
    shownFrozen = {
      draftId: openDraftId,
      card: openDraftId
        ? sidebarDraftCard(client.getState(), openDraftId, defaultProviderId)
        : null,
    }
    setFrozen(shownFrozen)
  }
  const frozenSessionId = shownFrozen.card?.sessionId ?? null

  const facts = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        enabled
          ? selectSidebarDrafts(state, openDraftId, frozenSessionId, defaultProviderId)
          : NO_DRAFT_FACTS,
      [defaultProviderId, enabled, frozenSessionId, openDraftId],
    ),
    sameSidebarDraftFacts,
  )
  // The draft on screen went (deleted elsewhere, or emptied here): its
  // snapshot is let go for good, so text typed next does not bring the old
  // card back. Like a draft first written here, it has a card once left.
  if (facts.openGone && shownFrozen.card && shownFrozen.draftId === openDraftId) {
    shownFrozen = { draftId: openDraftId, card: null }
    setFrozen(shownFrozen)
  }

  // One discard waits out its undo window at a time; its card is hidden
  // meanwhile, and nothing is deleted until the window closes.
  const [pending, setPending] = useState<PendingDraftDiscard | null>(null)
  const pendingRef = useRef<PendingDraftDiscard | null>(null)
  // The draft the discard was made on, to tell a change made elsewhere from
  // this client's own late save; watched through the store while it waits.
  const watchRef = useRef<WatchedDiscard | null>(null)
  const unwatchRef = useRef<(() => void) | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keyRef = useRef(0)

  const stopClock = useCallback(() => {
    if (timerRef.current === undefined) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  /**
   * The one place a discarded draft is let go. Images kept with a draft
   * (CAL-215) are released here too, once they are: read the draft's
   * `artifactIds` before deleting it.
   */
  const releaseDraft = useCallback((draftId: string) => sync?.discard(draftId), [sync])

  const settleDiscard = useCallback(
    (commit: boolean) => {
      const current = pendingRef.current
      if (!current) return
      stopClock()
      const watched = watchRef.current
      pendingRef.current = null
      watchRef.current = null
      unwatchRef.current?.()
      unwatchRef.current = undefined
      setPending(null)
      // Changed elsewhere since it was discarded: the card comes back instead.
      if (commit && watched && discardStands(client.getState(), current.draftId, watched)) {
        releaseDraft(current.draftId)
      }
    },
    [client, releaseDraft, stopClock],
  )

  const startClock = useCallback(() => {
    stopClock()
    timerRef.current = setTimeout(() => settleDiscard(true), DRAFT_DISCARD_UNDO_MS)
  }, [settleDiscard, stopClock])

  const discardDraft = useCallback(
    (draftId: string, options?: DraftDiscardOptions) => {
      if (!navigation || pendingRef.current?.draftId === draftId) return
      // A draft being sent is the send's: it becomes a session, or comes back.
      if (client.getState().draftEdits[draftId]?.launching) return
      // Only one waits: an earlier discard goes now.
      settleDiscard(true)
      const state = client.getState()
      keyRef.current += 1
      const next: PendingDraftDiscard = {
        draftId,
        key: keyRef.current,
        fromKeyboard: options?.fromKeyboard ?? false,
        returnFocus: options?.returnFocus ?? null,
      }
      const watched: WatchedDiscard = {
        revision: state.drafts[draftId]?.revision ?? 0,
        writing: false,
      }
      discardStands(state, draftId, watched)
      pendingRef.current = next
      watchRef.current = watched
      // Watched from now, not from the next render, so the composer's own
      // last keystrokes (written as its page closes, below) are known as ours.
      // Changed elsewhere meanwhile, the discard is called off at once and the
      // card comes back.
      unwatchRef.current = client.subscribe(() => {
        if (pendingRef.current !== next) return
        if (!discardStands(client.getState(), draftId, watched)) settleDiscard(false)
      })
      setPending(next)
      startClock()
      navigation.closeDraftPage(draftId)
    },
    [client, navigation, settleDiscard, startClock],
  )

  const undoDiscard = useCallback(
    (key?: number) => {
      if (isCurrent(pendingRef.current, key)) settleDiscard(false)
    },
    [settleDiscard],
  )
  const confirmDiscard = useCallback(
    (key?: number) => {
      if (isCurrent(pendingRef.current, key)) settleDiscard(true)
    },
    [settleDiscard],
  )
  const holdDiscard = useCallback(
    (held: boolean, key?: number) => {
      if (!isCurrent(pendingRef.current, key)) return
      if (held) stopClock()
      else startClock()
    },
    [startClock, stopClock],
  )

  // A discard is let go, not kept waiting, when the page is going: unloaded,
  // or frozen (which may end in a discard of the tab). Not when it is only
  // hidden: switching tabs and back within the window keeps the undo, and its
  // timer runs on meanwhile. Captured, so the deletion lands before the
  // host's own `pagehide` files the state away for the next load.
  useEffect(() => {
    const flush = () => settleDiscard(true)
    window.addEventListener('pagehide', flush, { capture: true })
    document.addEventListener('freeze', flush, { capture: true })
    return () => {
      window.removeEventListener('pagehide', flush, { capture: true })
      document.removeEventListener('freeze', flush, { capture: true })
      // Leaving this environment: the discard stands.
      flush()
    }
  }, [settleDiscard])

  // Back on the discarded draft's page (by its address) before the window
  // closed: the user wants it after all, and deleting it now would empty the
  // composer under them.
  const leftRef = useRef<number | null>(null)
  useEffect(() => {
    if (!pending) return
    if (openDraftId !== pending.draftId) leftRef.current = pending.key
    else if (leftRef.current === pending.key) settleDiscard(false)
  }, [openDraftId, pending, settleDiscard])

  const hidden = pending?.draftId ?? null
  const frozenCard = shownFrozen.card
  const drafts = useMemo(
    () => arrangeSidebarDrafts({ facts, frozen: frozenCard, hidden }),
    [facts, frozenCard, hidden],
  )
  const value = useMemo<SidebarDraftsValue | null>(
    () =>
      navigation && enabled
        ? {
            drafts,
            openDraftId,
            openDraft: navigation.openDraftPage,
            discardDraft,
            pendingDiscard: pending,
            undoDiscard,
            confirmDiscard,
            holdDiscard,
          }
        : null,
    [
      confirmDiscard,
      discardDraft,
      drafts,
      enabled,
      holdDiscard,
      navigation,
      openDraftId,
      pending,
      undoDiscard,
    ],
  )
  return <SidebarDraftsContext.Provider value={value}>{children}</SidebarDraftsContext.Provider>
}
