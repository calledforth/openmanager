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
import type { ProviderStatuses } from './draft-provider'
import { PlatformCapabilitiesContext } from './platform-provider'
import { SessionStateContext } from './session-provider'

const NO_STATUSES: ProviderStatuses = {}
import {
  SidebarDraftsContext,
  type DraftDiscardOptions,
  type PendingDraftDiscard,
  type SidebarDraftsValue,
} from './sidebar-provider'

/** How long a discarded draft can still be brought back. */
export const DRAFT_DISCARD_UNDO_MS = 6_000

/**
 * Whether a pending discard has anything left to take. A draft that is gone
 * (sent, or deleted elsewhere) has not, and one being sent is the send's.
 * Whether it was written since is not judged here: the delete names the
 * revision the discard was made on, and the environment refuses it if anyone
 * else has written the draft since (`DraftSync.discard`).
 */
function discardOutstanding(state: EnvironmentState, draftId: string) {
  const edit = state.draftEdits[draftId]
  if (edit?.launching) return false
  return state.drafts[draftId] !== undefined || edit !== undefined
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
  // Provider health, which the card's provider is chosen by as the composer's
  // is. It changes with a provider's health, never with typing.
  const statuses = useContext(PlatformCapabilitiesContext)?.agentUiStatusByProvider ?? NO_STATUSES
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
        ? sidebarDraftCard(client.getState(), openDraftId, defaultProviderId, statuses)
        : null,
    }
    setFrozen(shownFrozen)
  }
  const frozenSessionId = shownFrozen.card?.sessionId ?? null

  const facts = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        enabled
          ? selectSidebarDrafts(state, openDraftId, frozenSessionId, defaultProviderId, statuses)
          : NO_DRAFT_FACTS,
      [defaultProviderId, enabled, frozenSessionId, openDraftId, statuses],
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
  // The revision the discard was made on (0: never saved), which its delete
  // names; and the store watch that ends the discard if the draft goes.
  const madeOnRef = useRef(0)
  const unwatchRef = useRef<(() => void) | undefined>(undefined)
  // Holds the sync's record of this page's own answers for the draft while
  // its window runs; the delete holds it after that, until it is answered.
  const unpinRef = useRef<(() => void) | undefined>(undefined)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keyRef = useRef(0)

  const stopClock = useCallback(() => {
    if (timerRef.current === undefined) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  /**
   * The one place a discarded draft is let go. The delete is conditional:
   * written since by another client, the environment refuses it, the draft
   * stays, and its card comes back. The draft's images go with it, freed by
   * the environment in the delete itself, so a refused delete frees none.
   */
  const releaseDraft = useCallback(
    (draftId: string, madeOn: number) => sync?.discard(draftId, { ifRevision: madeOn }),
    [sync],
  )

  const settleDiscard = useCallback(
    (commit: boolean) => {
      const current = pendingRef.current
      if (!current) return
      stopClock()
      pendingRef.current = null
      unwatchRef.current?.()
      unwatchRef.current = undefined
      setPending(null)
      if (commit && discardOutstanding(client.getState(), current.draftId)) {
        releaseDraft(current.draftId, madeOnRef.current)
      }
      unpinRef.current?.()
      unpinRef.current = undefined
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
      pendingRef.current = next
      madeOnRef.current = state.drafts[draftId]?.revision ?? 0
      unpinRef.current = sync?.pinAnswer(draftId)
      // Gone meanwhile (sent, or deleted elsewhere): nothing is left to take,
      // and the notice goes at once. A draft written elsewhere meanwhile is
      // not judged here; the delete is refused for it when the window ends.
      unwatchRef.current = client.subscribe(() => {
        if (pendingRef.current !== next) return
        if (!discardOutstanding(client.getState(), draftId)) settleDiscard(false)
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
