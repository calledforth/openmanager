import { useEffect, useSyncExternalStore } from 'react'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'

import { discardHandoff } from './discard-handoff'

/**
 * Makes the discard a draft page asked for once that page has gone
 * (`discardHandoff`). Rendered once, inside the environment's providers.
 */
export function DraftDiscardHost() {
  const drafts = useSidebarDrafts()
  const waiting = useSyncExternalStore(
    discardHandoff.subscribe,
    discardHandoff.waiting,
    discardHandoff.waiting,
  )
  const openDraftId = drafts?.openDraftId ?? null
  const discard = drafts?.discardDraft ?? null
  useEffect(() => {
    discardHandoff.settle(openDraftId, discard)
  }, [discard, openDraftId, waiting])
  return null
}
