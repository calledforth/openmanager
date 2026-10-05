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
  type PendingDraftDiscard,
  type SidebarDraftsValue,
} from './sidebar-provider'

/** How long a discarded draft can still be brought back. */
export const DRAFT_DISCARD_UNDO_MS = 6_000

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

  // One discard waits out its undo window at a time; its card is hidden
  // meanwhile, and nothing is deleted until the window closes.
  const [pending, setPending] = useState<PendingDraftDiscard | null>(null)
  const pendingRef = useRef<PendingDraftDiscard | null>(null)
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
      pendingRef.current = null
      setPending(null)
      if (commit) releaseDraft(current.draftId)
    },
    [releaseDraft, stopClock],
  )

  const startClock = useCallback(() => {
    stopClock()
    timerRef.current = setTimeout(() => settleDiscard(true), DRAFT_DISCARD_UNDO_MS)
  }, [settleDiscard, stopClock])

  const discardDraft = useCallback(
    (draftId: string) => {
      if (!navigation || pendingRef.current?.draftId === draftId) return
      // Only one waits: an earlier discard goes now.
      settleDiscard(true)
      keyRef.current += 1
      const next = { draftId, key: keyRef.current }
      pendingRef.current = next
      setPending(next)
      startClock()
      navigation.closeDraftPage(draftId)
    },
    [navigation, settleDiscard, startClock],
  )
  const undoDiscard = useCallback(() => settleDiscard(false), [settleDiscard])
  const confirmDiscard = useCallback(() => settleDiscard(true), [settleDiscard])
  const holdDiscard = useCallback(
    (held: boolean) => {
      if (!pendingRef.current) return
      if (held) stopClock()
      else startClock()
    },
    [startClock, stopClock],
  )

  // A discard is let go, not kept waiting, when the page may not come back:
  // hidden (a phone may close the tab without another word) or unloading.
  useEffect(() => {
    const flush = () => settleDiscard(true)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
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
