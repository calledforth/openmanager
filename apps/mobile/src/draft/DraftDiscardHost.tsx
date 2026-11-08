import { useEffect, useSyncExternalStore } from 'react'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'

import { discardHandoff } from './discard-handoff'

/**
 * Makes the discard a draft page of this environment asked for once that
 * page has gone (`discardHandoff`). Rendered once per environment, inside
 * that environment's providers.
 */
export function DraftDiscardHost({ environmentId }: { environmentId: string }) {
  const drafts = useSidebarDrafts()
  const waiting = useSyncExternalStore(
    discardHandoff.subscribe,
    discardHandoff.waiting,
    discardHandoff.waiting,
  )
  const openDraftId = drafts?.openDraftId ?? null
  const discard = drafts?.discardDraft ?? null
  useEffect(() => {
    discardHandoff.settle(environmentId, openDraftId, discard)
  }, [discard, environmentId, openDraftId, waiting])
  return null
}
