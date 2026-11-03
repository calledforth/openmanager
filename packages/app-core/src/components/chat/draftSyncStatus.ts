import { useCallback, useSyncExternalStore } from 'react'
import type { DraftSyncStatus } from '@openmanager/environment-client'
import type { ComposerDraftStore } from './composerDraftStore'

/** Why a draft is not synced, in the words every "Not synced" mark uses. */
export const DRAFT_SYNC_EXPLANATION: Partial<Record<DraftSyncStatus, string>> = {
  offline: 'Saved on this device only. It syncs once the environment is reachable again.',
  unsupported: 'Saved on this device only. This environment does not keep drafts.',
  too_large: 'Too long to sync. Saved on this device until it is shorter.',
  failed: 'Saved on this device. Syncing failed and is being retried.',
}

/** The draft's sync status from its store; `synced` when the store does not sync. */
export function useDraftSyncStatus(store: ComposerDraftStore, draftKey: string): DraftSyncStatus {
  const read = useCallback(() => store.getSyncStatus?.(draftKey) ?? 'synced', [store, draftKey])
  return useSyncExternalStore(store.subscribe, read, read)
}
